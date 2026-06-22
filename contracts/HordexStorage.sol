// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./HordexTypes.sol";

// Shared storage layout for Hordex.sol and its DELEGATECALL facets.
// Variable names and order must never change — storage slots are position-sensitive.
abstract contract HordexStorage {

    // Public (auto-getters generated in concrete Hordex.sol)
    mapping(address => User)    public users;
    mapping(address => uint256) public userTotalInvested;
    address public featuredToken;
    address public owner;
    // platformToken is immutable in Hordex.sol / HordexFacet — not a storage slot.
    uint16[10] public referralCommissionRates;
    uint256    public minDirectReferralInvestment;

    // Internal protocol state (same names as original private vars — no renaming in function bodies)
    mapping(address => Token)                         internal tokens;
    mapping(address => LPLock[])                      internal userLPLocks;
    mapping(address => uint256)                       internal userCommissionsEarned;
    mapping(address => uint256)                       internal activeReferralCount;
    mapping(address => mapping(address => bytes))     internal _refLabels;
    uint256   internal totalRegisteredUsers;
    uint256   internal totalEthInvested;
    uint256   internal totalStakingRewardsPaidETH;
    address[] internal registeredTokens;
    address[] internal allRegisteredUsers;
    mapping(uint256 => bool) internal validPackageAmounts;

    // Staking config
    uint32[12]          internal investmentTiers;
    uint16[6]           internal stakingDurations;
    uint256[4][12][6]   internal stakingRates;

    bool internal _locked;

    // On-chain history records
    mapping(address => PriceSnap[])        internal _priceHistory;
    mapping(address => TradeSnap[])        internal _tradeHistory;
    mapping(address => CommissionRecord[]) internal _commissionRecords;
    mapping(address => InvestRecord[])     internal _investRecords;
    mapping(address => ClaimRecord[])      internal _claimRecords;
    mapping(address => LPEventRecord[])    internal _lpEventRecords;
    // Per-lock period history (initial + each restake) for the Lock History modal.
    // Keyed by user then lock index; one LockPeriod appended per invest/restake.
    mapping(address => mapping(uint256 => LockPeriod[])) internal _lockPeriods;

    // ROI commission state (used by HordexROIFacet via DELEGATECALL)
    mapping(address => mapping(uint256 => ROIStream[10])) internal _roiStreams;
    mapping(address => StreamRef[])                        internal _activeROIStreams;
    mapping(address => mapping(uint256 => StreamRef[]))   internal _skippedROIStreams;
    mapping(address => uint256)                           internal _roiPendingETH;
    // Streams deferred past an eligible person because they already hold a lower-level
    // (higher-rate) stream from the same lock — "one stream per lock" rule.
    mapping(address => StreamRef[])                        internal _deferredROIStreams;

    // Hard cap on how many simultaneously-live ROI streams a single recipient may hold in
    // _activeROIStreams. Every per-recipient loop (available-cap, settlement, _chargeCap
    // pre-settle, natural-expiry resume) iterates this array, and those run for each ancestor
    // during invest()'s commission distribution — so an unbounded array let a popular upline's
    // downline invests blow past the block gas limit. Bounding it makes invest()/claim gas O(M)
    // and DoS-proof. Overflow assignments are recorded in _skippedROIStreams (inert) instead of
    // pushed here. A recipient's lifetime earnings are already 5×-capped, so this only limits how
    // many downline locks accrue *concurrently*; restaking re-runs assignment, so a skipped level
    // can become live later once active slots free up.
    // Sizing: with Method 2 (commission distribution charges COMMITTED cap, O(locks)) and the lazy
    // natural-expiry resume (invest/restake record an O(1) checkpoint instead of looping streams —
    // see _handleNaturalExpiryResume / _absorbResume), none of the COMMON paths scale with a
    // recipient's stream count: invest/restake is O(locks), a single resume is O(1), and claimAllROI
    // is O(M) but fully chunkable (settleROIStreams + claimPendingROI). The ONLY residual O(M) is the
    // rare _drainPendingResume — it fires solely when a recipient resumes a SECOND time before any
    // claim/settle/downline-activity has absorbed the first checkpoint, costing ~69k gas/stream
    // (measured in test/resume-characterization.test.js). At M=5000 a full drain exceeds one block,
    // but that corner is escapable with ZERO fund risk: settle (chunked) to absorb the streams, then
    // re-invest is O(1) again. 5000 is high enough that a realistic upline never has its high-value
    // streams blocked, while single-tx claims/views stay manageable (chunk for the largest accounts).
    // For an absolutely revert-proof bound (no settle-first ever needed) keep M <= ~400; raising it
    // higher than 5000 safely would require bounding the drain itself.
    uint256 internal constant MAX_ACTIVE_ROI_STREAMS = 5000;

    // Helper shared by Hordex.sol and facets
    function _qualifies(address _user) internal view returns (bool) {
        uint256 total = userTotalInvested[_user];
        return total > 0 && (minDirectReferralInvestment == 0 || total >= minDirectReferralInvestment);
    }

    // Idempotently reconciles `user`'s contribution to their referrer's activeReferralCount.
    // Call after ANY change to userTotalInvested[user] (invest / removeLP). The +1 a user
    // contributes is tracked per-user via _countsForReferrer, so the count always equals the
    // number of currently-qualifying direct referrals and self-corrects on the user's next
    // action. This makes the count immune to drift/underflow when the owner changes
    // minDirectReferralInvestment out-of-band (the old wasQualifying/justQualified transition
    // logic assumed the qualification threshold never moved between a user's invest and exit).
    function _syncReferralCount(address user) internal {
        address ref = users[user].referrer;
        if (ref == address(0)) return;
        bool nowQ    = _qualifies(user);
        bool counted = _countsForReferrer[user];
        if (nowQ == counted) return;                 // already in sync — nothing to do
        if (nowQ) {
            _countsForReferrer[user] = true;
            activeReferralCount[ref]++;
        } else {
            _countsForReferrer[user] = false;
            if (activeReferralCount[ref] > 0) activeReferralCount[ref]--;   // clamp: never underflow
        }
    }

    // ROI accrual constants and helper — shared with Hordex.sol view functions so that
    // getROIAccrued/getROIPending can read directly from inherited storage instead of calling
    // the ROI facet as a regular CALL (which would read the facet's own empty storage).
    uint256 internal constant _ROI_DENOM         = 50_000_000_000;
    // 90-day ROI lock window, derived from the shared SECONDS_PER_DAY switch (HordexTypes.sol).
    uint256 internal constant _ROI_LOCK_DURATION = 90 * SECONDS_PER_DAY;

    function _calcAccrued(
        ROIStream storage stream,
        address investor,
        uint256 lockIndex,
        uint8   level
    ) internal view returns (uint256 accrued) {
        if (stream.ended || stream.recipient == address(0)) return 0;
        // Ineligible recipients (no investment) do not accumulate.
        if (stream.recipient != owner && !_qualifies(stream.recipient)) return 0;
        // Cap exhausted — accumulation paused until cap is refreshed.
        if (_getAvailableCap(stream.recipient) == 0) return 0;
        LPLock storage lock = userLPLocks[investor][lockIndex];
        uint256 lockDur = lock.unlockTime > lock.lockedAt
            ? lock.unlockTime - lock.lockedAt
            : _ROI_LOCK_DURATION;
        uint256 endTs   = block.timestamp < lock.unlockTime ? block.timestamp : lock.unlockTime;
        uint256 startTs = stream.recipientSince > lock.lockedAt
            ? stream.recipientSince
            : lock.lockedAt;
        if (endTs <= startTs) return 0;
        uint256 elapsed = _resumeAdjustedElapsed(stream.recipient, stream.recipientSince, startTs, endTs);
        uint256 rate    = roiCommissionRates[level];
        accrued = lock.ethInvested * lock.rewardRatePPM * elapsed * rate / (_ROI_DENOM * lockDur);
    }

    // ROI claim history (mirrors _claimRecords for staking; appended by claimAllROI/claimROIFromStream)
    mapping(address => ClaimRecord[]) internal _roiClaimRecords;

    // LP tokens currently held in custody for users, keyed by Uniswap pair address.
    // Incremented by investExt; decremented by claimLP (direct=false path) and
    // removeLPCoreExt when direct=true (LP still in contract).
    // withdrawToken subtracts this from the withdrawable balance so user LP is untouchable.
    mapping(address => uint256) internal _totalLockedLP;

    // TWAP state
    mapping(address => TwapObs) internal _tokenTwapObs0;
    mapping(address => TwapObs) internal _tokenTwapObs1;
    mapping(address => uint256) internal _tokenTwapPrice;
    mapping(address => uint256) internal _tokenTwapLastUpdated;
    mapping(address => bool)    internal _tokenTwapReady;

    // Cumulative missed commissions per user — updated by distributeCommissions whenever
    // a user is bypassed (ineligible level, no cap, wrong token, or cap overflow).
    // Stored on-chain to avoid unreliable eth_getLogs on Polygon Amoy.
    mapping(address => uint256) public totalMissedCommissions;

    // Individual missed-commission records for per-entry display in the frontend.
    mapping(address => MissedRecord[]) internal _missedRecords;

    // ROI-specific commission rates (basis points out of 10,000), independent of
    // referralCommissionRates which governs regular cash commissions.
    uint16[10] public roiCommissionRates;

    // Timestamp when a user's overall cap was last exhausted (0 = not paused).
    // Set by _chargeCap when cap hits 0; cleared by invest() when a new lock restores cap.
    mapping(address => uint64) internal _capPausedAt;

    // Whether `user` currently contributes +1 to their referrer's activeReferralCount.
    // Maintained by _syncReferralCount(). Appended at the end of storage so existing slots
    // are unchanged. (New value defaults to false for every address, matching a fresh count.)
    mapping(address => bool) internal _countsForReferrer;

    // ── ROI retention after full LP exit ───────────────────────────────────────
    // When a user removes their LAST cap-bearing lock, the LP is withdrawn but the lock's
    // leftover 5× cap is RETAINED here as a frozen budget so ROI already earned (bounded at
    // the lock's expiry) stays claimable instead of being lost. Set by removeLPCoreExt on full
    // exit; the inclExpired cap helper adds this budget, _chargeCapInclExpired draws it down
    // (preventing re-claim), _naturalExpiryOf bounds settlement at _roiRetainedAt, and the
    // accrual helpers bypass the _qualifies gate while _roiRetainedAt != 0. Cleared by invest()
    // on re-entry (after _handleNaturalExpiryResume preserves the earned ROI into pending).
    // Appended at the end of storage so existing slots are unchanged (both default to 0).
    mapping(address => uint256) internal _roiRetainedCap;
    mapping(address => uint64)  internal _roiRetainedAt;

    // ── Lazy natural-expiry resume (O(1) invest/restake) ───────────────────────
    // _handleNaturalExpiryResume used to loop ALL of a recipient's active ROI streams inside
    // invest()/restakeLP() (~70k gas/stream → block-limit DoS for big uplines). Instead we now
    // record an O(1) per-user checkpoint of the most recent natural-expiry resume and reconcile
    // each stream LAZILY the next time it is individually touched (settle/claim/end) via
    // _absorbResume. Until a stream is absorbed, the accrual helpers exclude the forfeited
    // no-stake gap (boundary, resumeAt) so views/cap match the eventual post-absorption result.
    //   _roiResumeBoundary = E: the recipient's last natural-expiry timestamp (0 = no pending resume)
    //   _roiResumeAt       = T: the re-entry (re-invest/restake) timestamp; gap (E,T) is forfeited
    //   _roiUnabsorbed     = streams that have not yet absorbed the current checkpoint
    // A new resume drains any still-unabsorbed prior checkpoint first (rare) so each stream ever
    // carries AT MOST ONE forfeited gap — preventing multi-gap over-credit. Appended at the end
    // of storage so existing slots are unchanged (all default to 0).
    mapping(address => uint256) internal _roiResumeBoundary;
    mapping(address => uint256) internal _roiResumeAt;
    mapping(address => uint256) internal _roiUnabsorbed;

    // ── Level-eligibility: ACTIVE self-stake gate (per 0-indexed level for ROI) ──────────────
    // Eligibility is gated purely by ACTIVE self-stake (USDT, sum of non-removed non-expired
    // locks) — the team-business gate has been REMOVED from both referral and ROI.
    //   • Referral commissions: FLAT gate — a single active self-stake >= selfStakeGate[0] ($25)
    //     unlocks ALL 10 referral levels (DECOUPLED from ROI; see _eligibleForReferralLevel). An
    //     ancestor below $25 earns no referral at any level and that amount goes to the deployer.
    //   • ROI streams: per-level gate active self-stake >= selfStakeGate[i] (see _eligibleForLevel).
    //     An ineligible upline is skipped at assignment (no stream created); a live stream's accrual
    //     stops via the cap/natural-expiry machinery once stake fully expires (cap → 0), forfeiting
    //     the no-stake gap while pre-expiry earned ROI stays claimable.
    // Self gate is ACTIVE — it falls when locks expire, so a recipient's eligible depth drops.
    // selfStakeGate is owner-settable (defaults seeded in the Hordex constructor).
    // businessGate is RETAINED for storage-layout/ABI stability but is NO LONGER consulted for
    // eligibility (seeded to zero); _teamBusinessUSDT is still rolled up purely as a display stat.
    uint32[10] internal selfStakeGate;
    uint32[10] internal businessGate;          // inert: no longer gates eligibility
    mapping(address => uint256) internal _teamBusinessUSDT;

    uint256 private constant _USDT_PER_ETH = 1;

    // Active self-stake (WETH wei) = sum of ethInvested across the user's non-removed, non-expired
    // locks. This is the per-event 1× wallet cap for referral commissions (HordexFacet) — the band
    // above it (up to 5×) is routed to the reserve instead of being paid out immediately.
    function _activeSelfStakeWei(address _user) internal view returns (uint256 sumWei) {
        LPLock[] storage locks = userLPLocks[_user];
        uint256 len = locks.length;
        for (uint256 j = 0; j < len; ) {
            LPLock storage l = locks[j];
            if (!l.removed && block.timestamp < l.unlockTime) sumWei += l.ethInvested;
            unchecked { j++; }
        }
    }

    // Active self-stake (USDT) = the wei sum above, converted 1:1.
    function _activeSelfStakeUSDT(address _user) internal view returns (uint256) {
        return _activeSelfStakeWei(_user) * _USDT_PER_ETH / 1e18;
    }

    // ROI eligibility: whether `_user` currently qualifies to RECEIVE an ROI stream at 0-indexed
    // `level`. Per-level ACTIVE self-stake gate only — the team-business gate has been removed.
    // Owner is the catch-all sink and always qualifies.
    function _eligibleForLevel(address _user, uint8 level) internal view returns (bool) {
        if (_user == owner) return true;
        return _activeSelfStakeUSDT(_user) >= selfStakeGate[level];
    }

    // Referral-commission eligibility: FLAT gate, DECOUPLED from ROI. A single active self-stake of
    // >= selfStakeGate[0] ($25) unlocks ALL 10 referral levels at once (the `level` argument is
    // ignored). This differs from ROI, which keeps the per-level gate (_eligibleForLevel: $25 → L1,
    // $50 → L1-2, $100 → L1-3, …). An ancestor below $25 earns no referral commission at any level;
    // that level's amount goes to the deployer (owner). Owner always qualifies.
    function _eligibleForReferralLevel(address _user, uint8 /* level */) internal view returns (bool) {
        if (_user == owner) return true;
        return _activeSelfStakeUSDT(_user) >= selfStakeGate[0];
    }

    // Adjusts an accrual window [startTs, endTs] by subtracting the forfeited natural-expiry gap
    // (boundary, resumeAt) when the stream's recipient has a pending resume the stream has not yet
    // absorbed (recipientSince < resumeAt). Caller guarantees endTs > startTs. Returns the eligible
    // elapsed seconds (= full span minus the overlap with the forfeited gap).
    function _resumeAdjustedElapsed(
        address recipient, uint256 recipientSince, uint256 startTs, uint256 endTs
    ) private view returns (uint256 elapsed) {
        elapsed = endTs - startTs;
        uint256 T = _roiResumeAt[recipient];
        if (T == 0 || recipientSince >= T) return elapsed;   // no pending resume, or already absorbed
        uint256 E  = _roiResumeBoundary[recipient];
        uint256 lo = startTs > E ? startTs : E;              // max(startTs, E)
        uint256 hi = endTs   < T ? endTs   : T;              // min(endTs, T)
        if (hi > lo) elapsed -= (hi - lo);                   // subtract overlap with the forfeited gap
    }

    // Lazily reconciles ONE stream against its recipient's pending resume the first time it is
    // touched after the resume: banks the pre-expiry earned ROI as held-carry (the surrounding
    // settle then converts it to pending up to cap — matching the old eager behaviour), forfeits
    // the no-stake gap (E,T) into historicalMissedETH, and advances recipientSince to the resume
    // time so future accrual is clean. Idempotent (recipientSince >= T ⇒ no-op).
    function _absorbResume(ROIStream storage stream, address investor, uint256 lockIndex, uint8 level) internal {
        address recip = stream.recipient;
        if (recip == address(0)) return;
        uint256 T = _roiResumeAt[recip];
        if (T == 0 || stream.recipientSince >= T) return;
        uint256 E = _roiResumeBoundary[recip];

        LPLock storage lock = userLPLocks[investor][lockIndex];
        uint256 lockDur = lock.unlockTime > lock.lockedAt ? lock.unlockTime - lock.lockedAt : _ROI_LOCK_DURATION;
        uint256 startTs = stream.recipientSince > lock.lockedAt ? stream.recipientSince : lock.lockedAt;
        uint256 lockEnd = lock.unlockTime;
        uint256 rate    = roiCommissionRates[level];

        // Pre-expiry earned ROI = accrual over [startTs, min(E, lockEnd)] → held (settled to pending
        // up to cap by the _settleHeldCarry that runs right after this in the settle flow).
        uint256 preEnd = E < lockEnd ? E : lockEnd;
        if (preEnd > startTs) {
            uint256 pe = lock.ethInvested * lock.rewardRatePPM * (preEnd - startTs) * rate / (_ROI_DENOM * lockDur);
            if (pe > 0) stream.heldCarryETH += uint128(pe);
        }
        // Forfeited no-stake gap = accrual over [max(E, startTs), min(T, lockEnd)] → missed.
        uint256 gLo = startTs > E ? startTs : E;
        uint256 gHi = T < lockEnd ? T : lockEnd;
        if (gHi > gLo) {
            uint256 gp = lock.ethInvested * lock.rewardRatePPM * (gHi - gLo) * rate / (_ROI_DENOM * lockDur);
            if (gp > 0) stream.historicalMissedETH += uint128(gp);
        }

        stream.recipientSince = uint64(T);
        if (_roiUnabsorbed[recip] > 0) _roiUnabsorbed[recip]--;
    }

    // Eagerly absorbs every still-unabsorbed active stream of a recipient against the CURRENT
    // checkpoint. Only invoked by _handleNaturalExpiryResume when a prior resume hasn't fully
    // drained before a new one arrives (rare) — bounds each stream to a single forfeited gap.
    function _drainPendingResume(address _user) internal {
        StreamRef[] storage sRefs = _activeROIStreams[_user];
        uint256 sLen = sRefs.length;
        for (uint256 k = 0; k < sLen; ) {
            StreamRef storage s = sRefs[k];
            ROIStream storage st = _roiStreams[s.investor][s.lockIndex][s.level];
            if (!st.ended) _absorbResume(st, s.investor, s.lockIndex, s.level);
            unchecked { k++; }
        }
    }

    // ── Unified cap helpers (shared by HordexFacet and Hordex.sol) ────────
    // Single overall cap per LP lock = ethInvested × 5.
    // commissionsCapUsed is consumed by BOTH regular referral commissions and ROI claims.
    // Only active (non-expired, non-removed) locks contribute available cap.

    // Raw cap: sum of (lock cap − commissionsCapUsed) across active locks.
    // Used by _chargeCap and claim functions where the charge amount must be compared
    // against storage-committed cap only (not live accrual).
    function _getRawAvailableCap(address _user) internal view returns (uint256 available) {
        LPLock[] storage locks = userLPLocks[_user];
        uint256 len = locks.length;
        for (uint256 j = 0; j < len; ) {
            LPLock storage l = locks[j];
            if (!l.removed && !l.capPaused && block.timestamp < l.unlockTime) {
                uint256 cap = l.ethInvested * 5;
                if (l.commissionsCapUsed < cap) available += cap - l.commissionsCapUsed;
            }
            unchecked { j++; }
        }
    }

    // Settlement cap: same as _getRawAvailableCap but also counts expired (non-removed) locks.
    // Used by ROI settlement functions so that ROI earned during a lock period can still be
    // collected after the lock expires — the lock's remaining cap covers the settlement.
    // NOT used for live-accrual gating (_calcAccrued uses active-only cap via _getAvailableCap).
    function _getRawAvailableCapInclExpired(address _user) internal view returns (uint256 available) {
        LPLock[] storage locks = userLPLocks[_user];
        uint256 len = locks.length;
        for (uint256 j = 0; j < len; ) {
            LPLock storage l = locks[j];
            if (!l.removed && !l.capPaused) {
                uint256 cap = l.ethInvested * 5;
                if (l.commissionsCapUsed < cap) available += cap - l.commissionsCapUsed;
            }
            unchecked { j++; }
        }
        // Frozen budget retained after a full LP exit so earned ROI is still settlement-claimable.
        available += _roiRetainedCap[_user];
    }

    // Like _chargeCap but charges both active and expired (non-removed) locks.
    // Used when settling ROI from expired locks so commissionsCapUsed is committed
    // and the same amounts cannot be claimed again after a new investment restores cap.
    function _chargeCapInclExpired(address _user, uint256 _amount) internal {
        LPLock[] storage locks = userLPLocks[_user];
        uint256 len = locks.length;
        uint256 remaining = _amount;
        for (uint256 j = 0; j < len && remaining > 0; ) {
            LPLock storage l = locks[j];
            if (!l.removed && !l.capPaused) {
                uint256 cap = l.ethInvested * 5;
                if (l.commissionsCapUsed < cap) {
                    uint256 space    = cap - l.commissionsCapUsed;
                    uint256 toCharge = remaining < space ? remaining : space;
                    l.commissionsCapUsed += toCharge;
                    remaining -= toCharge;
                }
            }
            unchecked { j++; }
        }
        // Commit against the retained budget last, so the same earned ROI can't be claimed twice.
        if (remaining > 0 && _roiRetainedCap[_user] > 0) {
            uint256 r = remaining < _roiRetainedCap[_user] ? remaining : _roiRetainedCap[_user];
            _roiRetainedCap[_user] -= r;
        }
    }

    // Computes ROI accrual without the cap-exhaustion guard.
    // Used by _getAvailableCap (to deduct live ROI) and settle functions (to settle
    // cap-bounded amounts even after cap is logically zero).
    function _calcAccruedRaw(
        ROIStream storage stream,
        address investor,
        uint256 lockIndex,
        uint8   level
    ) internal view returns (uint256 accrued) {
        if (stream.ended || stream.recipient == address(0)) return 0;
        // Retained recipients (withdrawn but cap preserved) keep accruing the earned-but-unclaimed
        // ROI; the _roiRetainedCap budget and _naturalExpiryOf bound cap this, so skip the gate.
        if (stream.recipient != owner && _roiRetainedAt[stream.recipient] == 0 && !_qualifies(stream.recipient)) return 0;
        LPLock storage lock = userLPLocks[investor][lockIndex];
        uint256 lockDur = lock.unlockTime > lock.lockedAt
            ? lock.unlockTime - lock.lockedAt
            : _ROI_LOCK_DURATION;
        uint256 endTs   = block.timestamp < lock.unlockTime ? block.timestamp : lock.unlockTime;
        uint256 startTs = stream.recipientSince > lock.lockedAt
            ? stream.recipientSince
            : lock.lockedAt;
        if (endTs <= startTs) return 0;
        uint256 elapsed = _resumeAdjustedElapsed(stream.recipient, stream.recipientSince, startTs, endTs);
        uint256 rate    = roiCommissionRates[level];
        accrued = lock.ethInvested * lock.rewardRatePPM * elapsed * rate / (_ROI_DENOM * lockDur);
    }

    // Like _calcAccruedRaw but bounded to a custom end timestamp.
    // Used by _handleNaturalExpiryResume to split pre-expiry ROI from gap-period ROI.
    function _calcAccruedRawAt(
        ROIStream storage stream,
        address investor,
        uint256 lockIndex,
        uint8   level,
        uint256 endBound
    ) internal view returns (uint256 accrued) {
        if (stream.ended || stream.recipient == address(0)) return 0;
        if (stream.recipient != owner && _roiRetainedAt[stream.recipient] == 0 && !_qualifies(stream.recipient)) return 0;
        LPLock storage lock = userLPLocks[investor][lockIndex];
        uint256 lockDur = lock.unlockTime > lock.lockedAt
            ? lock.unlockTime - lock.lockedAt
            : _ROI_LOCK_DURATION;
        uint256 endTs   = endBound < lock.unlockTime ? endBound : lock.unlockTime;
        uint256 startTs = stream.recipientSince > lock.lockedAt
            ? stream.recipientSince
            : lock.lockedAt;
        if (endTs <= startTs) return 0;
        uint256 elapsed = _resumeAdjustedElapsed(stream.recipient, stream.recipientSince, startTs, endTs);
        uint256 rate    = roiCommissionRates[level];
        accrued = lock.ethInvested * lock.rewardRatePPM * elapsed * rate / (_ROI_DENOM * lockDur);
    }

    // Real-time available cap = raw cap − pending ROI − live ROI accruing across all streams.
    // ROI is counted as earned the moment it accrues, so it reduces available cap immediately
    // whether or not the user has claimed it.  _calcAccrued uses this as its gate so that
    // accumulation stops as soon as the combined total (referral + pending + live) reaches cap.
    function _getAvailableCap(address _user) internal view returns (uint256) {
        return _availFromRaw(_user, _getRawAvailableCap(_user));
    }

    // Same as _getAvailableCap but its raw base includes expired (non-removed) locks, so it
    // reflects the cap that is still settlement-claimable after a lock expires.  Used by the
    // view-layer getter so the UI's "available cap" matches the contract in every state —
    // including ROI-driven exhaustion, where getROIData() reports liveETH = 0.
    function _getAvailableCapInclExpired(address _user) internal view returns (uint256) {
        return _availFromRaw(_user, _getRawAvailableCapInclExpired(_user));
    }

    // Shared core: raw cap − pending ROI − live ROI accruing across all active streams.
    // (Extracted verbatim from _getAvailableCap so its behavior is unchanged.)
    function _availFromRaw(address _user, uint256 raw) private view returns (uint256 available) {
        if (raw == 0) return 0;

        uint256 pending = _roiPendingETH[_user];
        if (pending >= raw) return 0;
        available = raw - pending;

        StreamRef[] storage sRefs = _activeROIStreams[_user];
        uint256 sLen = sRefs.length;
        for (uint256 k = 0; k < sLen; ) {
            StreamRef storage sRef = sRefs[k];
            ROIStream storage s = _roiStreams[sRef.investor][sRef.lockIndex][sRef.level];
            if (!s.ended && s.recipient == _user) {
                uint256 a = _calcAccruedRaw(s, sRef.investor, sRef.lockIndex, sRef.level);
                if (a >= available) return 0;
                available -= a;
            }
            unchecked { k++; }
        }
    }

    // Committed cap available for charging a NEW referral commission: raw cap minus already-settled
    // pending ROI (O(locks) + O(1)). Method 2: deliberately does NOT subtract live/unsettled ROI, so
    // the commission path never iterates the recipient's stream array — invest stays O(locks) and is
    // safe no matter how many streams the recipient holds. Banked (pending) ROI is still protected;
    // only not-yet-settled ROI yields to a commission at the exact cap boundary and resurfaces as
    // held ROI at claim time.
    function _getCommissionCap(address _user) internal view returns (uint256) {
        uint256 raw  = _getRawAvailableCap(_user);
        uint256 pend = _roiPendingETH[_user];
        return raw > pend ? raw - pend : 0;
    }

    function _chargeCap(address _user, uint256 _amount) internal {
        // Method 2: no per-stream pre-settle (O(locks), never iterates the stream array). _capPausedAt
        // records WHEN the recipient's raw cap reached 0 — whether this charge overflowed it
        // (remaining > 0) OR exactly filled it. That timestamp is the boundary a later invest/restake
        // uses to FORFEIT the no-available-cap gap: ROI accruing while raw cap is 0 is missed, not held.
        LPLock[] storage locks = userLPLocks[_user];
        uint256 len = locks.length;
        uint256 remaining = _amount;
        for (uint256 j = 0; j < len && remaining > 0; ) {
            LPLock storage l = locks[j];
            if (!l.removed && !l.capPaused && block.timestamp < l.unlockTime) {
                uint256 cap = l.ethInvested * 5;
                if (l.commissionsCapUsed < cap) {
                    uint256 space    = cap - l.commissionsCapUsed;
                    uint256 toCharge = remaining < space ? remaining : space;
                    l.commissionsCapUsed += toCharge;
                    remaining -= toCharge;
                }
            }
            unchecked { j++; }
        }

        if (remaining > 0) {
            _capPausedAt[_user] = uint64(block.timestamp);
        } else if (_capPausedAt[_user] == 0 && _getRawAvailableCap(_user) == 0) {
            // Charge fit exactly and left zero raw cap — still mark the exhaustion time so the
            // no-available-cap gap until the next invest/restake is forfeited (not recoverable).
            _capPausedAt[_user] = uint64(block.timestamp);
        }
    }

    // Called when an investor re-enters (invest/restake) after _getRawAvailableCap was 0 without
    // _capPausedAt being explicitly set. lastExpiry > 0 means a lock expired naturally: the ROI
    // earned up to lastExpiry stays claimable while the no-stake gap (lastExpiry → now) is forfeited
    // (rule 2 — skin-in-the-game). lastExpiry == 0 (cap-exhausted-while-staked, or no prior lock)
    // forfeits nothing — over-cap ROI is HELD and settles lazily once cap regains.
    //
    // O(1): instead of looping every active stream here (the old version cost ~70k gas/stream and
    // could exceed the block gas limit for big uplines), record a per-user resume checkpoint. Each
    // stream reconciles itself lazily on its next settle/claim/end via _absorbResume, and the
    // accrual helpers exclude the forfeited gap (boundary, resumeAt) until then — so views, cap, and
    // claims see the same result the old eager loop produced (pre-expiry preserved, gap forfeited,
    // no double-pay), only deferred. A still-unabsorbed prior checkpoint is drained first (rare) so
    // no stream ever carries two gaps.
    function _handleNaturalExpiryResume(address _user, uint256 lastExpiry) internal {
        if (lastExpiry == 0) return;
        if (_roiResumeAt[_user] != 0 && _roiUnabsorbed[_user] > 0) {
            _drainPendingResume(_user);
        }
        _roiResumeBoundary[_user] = lastExpiry;
        _roiResumeAt[_user]       = block.timestamp;
        _roiUnabsorbed[_user]     = _activeROIStreams[_user].length;
    }

    // ── Referral-commission RESERVE (held over-1× commission) ────────────────────
    // When a single downline investment pays an eligible upline more than its per-event 1× wallet
    // cap (active self-stake), the over-1× band (bounded by the 5× cap) is HELD here instead of
    // being paid out immediately. Each chunk (tranche) is net of the 5% deployer cut and unlocks at
    // the TRIGGERING downline package's 90-day unlock time. A tranche is claimable for WETH after it
    // unlocks (claimReserve) and spendable on a new package at any time (investFromReserve). The 5×
    // cap is already charged (commissionsCapUsed) when the reserve is created, so a later claim/spend
    // does NOT charge cap again. Appended at the end of storage so existing slots are unchanged.
    mapping(address => ReserveTranche[]) internal _reserveTranches;
    mapping(address => uint256)          internal _reserveTotalWei; // O(1) sum of all tranche amounts

    // Append a new reserve tranche (net amount, already after the 5% cut) and bump the running total.
    function _pushReserveTranche(address _user, uint256 _netAmount, uint64 _unlockTime) internal {
        _reserveTranches[_user].push(ReserveTranche({
            amount:     uint128(_netAmount),
            unlockTime: _unlockTime
        }));
        _reserveTotalWei[_user] += _netAmount;
    }

    // Sum of tranches that have reached their unlock time (claimable now).
    function _reserveClaimableWei(address _user) internal view returns (uint256 sum) {
        ReserveTranche[] storage tr = _reserveTranches[_user];
        uint256 n = tr.length;
        for (uint256 i = 0; i < n; ) {
            if (block.timestamp >= tr[i].unlockTime) sum += tr[i].amount;
            unchecked { i++; }
        }
    }

    // Remove and return the total of all MATURED tranches (compacting the array; unmatured kept in
    // their original order). O(tranches).
    function _consumeMaturedReserve(address _user) internal returns (uint256 claimed) {
        ReserveTranche[] storage tr = _reserveTranches[_user];
        uint256 n = tr.length;
        uint256 write = 0;
        for (uint256 read = 0; read < n; ) {
            ReserveTranche memory cur = tr[read];
            if (block.timestamp >= cur.unlockTime) {
                claimed += cur.amount;                 // matured → claim, drop
            } else {
                if (write != read) tr[write] = cur;    // keep, compact toward front
                unchecked { write++; }
            }
            unchecked { read++; }
        }
        while (tr.length > write) tr.pop();
        if (claimed > 0) {
            uint256 t = _reserveTotalWei[_user];
            _reserveTotalWei[_user] = t > claimed ? t - claimed : 0;
        }
    }

    // Spend `_amount` of reserve FIFO (oldest tranche first), regardless of maturity. Used to buy a
    // package from reserve. Caller MUST guarantee _reserveTotalWei[_user] >= _amount. O(tranches).
    function _consumeReserve(address _user, uint256 _amount) internal {
        ReserveTranche[] storage tr = _reserveTranches[_user];
        uint256 n = tr.length;
        uint256 remaining = _amount;
        uint256 write = 0;
        for (uint256 read = 0; read < n; ) {
            ReserveTranche memory cur = tr[read];
            if (remaining == 0) {
                if (write != read) tr[write] = cur;     // fully past the spend — keep as-is
                unchecked { write++; }
            } else if (cur.amount <= remaining) {
                remaining -= cur.amount;                // consume whole tranche
            } else {
                cur.amount = uint128(cur.amount - remaining); // partially consume boundary tranche
                remaining  = 0;
                tr[write]  = cur;
                unchecked { write++; }
            }
            unchecked { read++; }
        }
        while (tr.length > write) tr.pop();
        _reserveTotalWei[_user] -= _amount;             // safe: caller guarantees _amount <= total
    }
}
