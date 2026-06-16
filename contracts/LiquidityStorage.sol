// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./LiquidityTypes.sol";

// Shared storage layout for Liquidity.sol and its DELEGATECALL facets.
// Variable names and order must never change — storage slots are position-sensitive.
abstract contract LiquidityStorage {

    // Public (auto-getters generated in concrete Liquidity.sol)
    mapping(address => User)    public users;
    mapping(address => uint256) public userTotalInvested;
    address public featuredToken;
    address public owner;
    // platformToken is immutable in Liquidity.sol / LiquidityFacet — not a storage slot.
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

    // ROI commission state (used by LiquidityROIFacet via DELEGATECALL)
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
    // Sizing (Method 2): commission distribution now charges COMMITTED cap (O(locks)) and never
    // iterates ancestors' stream arrays, so investing under a popular upline is O(locks) regardless
    // of how many streams they hold. The cap now only bounds a recipient's OWN paths — the
    // natural-expiry resume loop and a single-tx claimAllROI (~M × ~6k gas). M=2000 keeps those
    // ~12M gas (safe under Polygon's 30M block limit) while being effectively unlimited for any real
    // account (and claims beyond one tx can always be chunked via settleROIStreams/claimPendingROI).
    uint256 internal constant MAX_ACTIVE_ROI_STREAMS = 2000;

    // Helper shared by Liquidity.sol and facets
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

    // ROI accrual constants and helper — shared with Liquidity.sol view functions so that
    // getROIAccrued/getROIPending can read directly from inherited storage instead of calling
    // the ROI facet as a regular CALL (which would read the facet's own empty storage).
    uint256 internal constant _ROI_DENOM         = 50_000_000_000;
    uint256 internal constant _ROI_LOCK_DURATION = 540; // 90 days scaled: 1 day = 6 s (testing)

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
        uint256 elapsed = endTs - startTs;
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

    // ── Unified cap helpers (shared by LiquidityFacet and Liquidity.sol) ────────
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
        uint256 elapsed = endTs - startTs;
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
        uint256 elapsed = endTs - startTs;
        uint256 rate    = roiCommissionRates[level];
        accrued = lock.ethInvested * lock.rewardRatePPM * elapsed * rate / (_ROI_DENOM * lockDur);
    }

    // Held-ROI: advance a stream's recipientSince by ONLY the time-equivalent of `settled` (accrual
    // is linear in time), so any over-cap remainder (accrued − settled) stays claimable later once
    // the recipient regains cap. `bound` is the upper end of the accrual window: block.timestamp for
    // a live settle, or a custom end-bound for natural-expiry/retention settles. Nothing is forfeited.
    function _advanceRecipientSince(
        ROIStream storage stream, address investor, uint256 lockIndex,
        uint256 accrued, uint256 settled, uint256 bound
    ) internal {
        LPLock storage lock = userLPLocks[investor][lockIndex];
        uint256 endTs   = bound < lock.unlockTime ? bound : lock.unlockTime;
        uint256 startTs = stream.recipientSince > lock.lockedAt ? stream.recipientSince : lock.lockedAt;
        if (endTs <= startTs) { stream.recipientSince = uint64(bound); return; }
        stream.recipientSince = settled >= accrued
            ? uint64(endTs)
            : uint64(startTs + (endTs - startTs) * settled / accrued);
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
        // Method 2: no per-stream pre-settle. Over-cap ROI is HELD (settled lazily at claim time,
        // bounded by remaining cap) rather than frozen here — so this stays O(locks) and never
        // iterates the recipient's stream array. _capPausedAt is set only when the raw cap across
        // ALL active locks is genuinely exhausted (remaining > 0 after the FIFO loop below).
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
        }
    }

    // Called when an investor re-enters (invest/restake) after _getRawAvailableCap was 0
    // without _capPausedAt being explicitly set.  Two sub-cases:
    //   lastExpiry > 0 — locks existed and expired naturally.  Settle pre-expiry ROI, then
    //                    record gap (lastExpiry → now) as missed.
    //   lastExpiry = 0 — user had no locks at all (first investment as referrer, etc.).
    //                    No pre-expiry settlement; the entire accrual window is the gap.
    // In both cases recipientSince is reset so future accrual starts clean from now.
    function _handleNaturalExpiryResume(address _user, uint256 lastExpiry) internal {
        // Cap-exhausted-while-staked (lastExpiry == 0): ROI is HELD, not forfeited — there is no
        // no-stake gap to exclude, so nothing to do. The over-cap remainder stays claimable and is
        // settled lazily at claim time once the recipient's cap regains headroom. Only a genuine
        // natural expiry (lastExpiry > 0, a lock actually past its unlock time) settles pre-expiry
        // ROI and forfeits the post-expiry no-stake gap (rule 2 — skin-in-the-game).
        if (lastExpiry == 0) return;
        // Only pre-expiry settlement needs a cap; gap recording never does.
        uint256 capRem = 0;
        if (lastExpiry > 0) {
            uint256 rawCap      = _getRawAvailableCapInclExpired(_user);
            uint256 alreadyPend = _roiPendingETH[_user];
            capRem = rawCap > alreadyPend ? rawCap - alreadyPend : 0;
        }

        StreamRef[] storage sRefs = _activeROIStreams[_user];
        uint256 sLen = sRefs.length;
        for (uint256 k = 0; k < sLen; ) {
            StreamRef storage sRef = sRefs[k];
            ROIStream storage s = _roiStreams[sRef.investor][sRef.lockIndex][sRef.level];
            if (!s.ended) {
                uint256 preExpiry = 0;
                if (lastExpiry > 0) {
                    // Pre-expiry: settle ROI accrued from recipientSince up to lastExpiry.
                    preExpiry = _calcAccruedRawAt(s, sRef.investor, sRef.lockIndex, sRef.level, lastExpiry);
                    if (preExpiry > 0) {
                        uint256 toSettle = preExpiry < capRem ? preExpiry : capRem;
                        if (toSettle > 0) {
                            s.roiPaidETH          += uint128(toSettle);
                            _roiPendingETH[_user] += toSettle;
                            capRem -= toSettle;
                        }
                        // Pre-expiry held that exceeds the fresh cap was EARNED while staked — it is
                        // HELD, not forfeited. Preserve it as carry so it settles once cap regains
                        // (e.g. the recipient invests more). Only the post-expiry gap below is missed.
                        if (preExpiry > toSettle) s.heldCarryETH += uint128(preExpiry - toSettle);
                    }
                }
                // Gap: ROI from lastExpiry (or stream start when lastExpiry=0) to now.
                uint256 fullRaw = _calcAccruedRaw(s, sRef.investor, sRef.lockIndex, sRef.level);
                uint256 gapROI  = fullRaw > preExpiry ? fullRaw - preExpiry : 0;
                if (gapROI > 0) {
                    // ROI gap is tracked per-stream in historicalMissedETH only.
                    // totalMissedCommissions / _missedRecords track referral commission misses only.
                    s.historicalMissedETH += uint128(gapROI);
                }
                s.recipientSince = uint64(block.timestamp);
            }
            unchecked { k++; }
        }
    }
}
