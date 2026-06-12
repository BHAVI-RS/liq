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

    // Helper shared by Liquidity.sol and facets
    function _qualifies(address _user) internal view returns (bool) {
        uint256 total = userTotalInvested[_user];
        return total > 0 && (minDirectReferralInvestment == 0 || total >= minDirectReferralInvestment);
    }

    // ROI accrual constants and helper — shared with Liquidity.sol view functions so that
    // getROIAccrued/getROIPending can read directly from inherited storage instead of calling
    // the ROI facet as a regular CALL (which would read the facet's own empty storage).
    uint256 internal constant _ROI_DENOM         = 50_000_000_000;
    uint256 internal constant _ROI_LOCK_DURATION = 180; // 90 days scaled: 1 day = 2 s (testing)

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
        if (stream.recipient != owner && !_qualifies(stream.recipient)) return 0;
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
        if (stream.recipient != owner && !_qualifies(stream.recipient)) return 0;
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

    // Real-time available cap = raw cap − pending ROI − live ROI accruing across all streams.
    // ROI is counted as earned the moment it accrues, so it reduces available cap immediately
    // whether or not the user has claimed it.  _calcAccrued uses this as its gate so that
    // accumulation stops as soon as the combined total (referral + pending + live) reaches cap.
    function _getAvailableCap(address _user) internal view returns (uint256 available) {
        uint256 raw = _getRawAvailableCap(_user);
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

    function _chargeCap(address _user, uint256 _amount) internal {
        // Pre-settlement guard: when this commission would push live cap (raw − pending − ROI)
        // to zero, pre-settle ROI streams NOW so they are frozen at the cap boundary.
        // _capPausedAt is set separately only when the raw commission cap across ALL active
        // locks is genuinely exhausted (remaining > 0 after the FIFO loop below).
        uint256 rawAvailable = _getRawAvailableCap(_user);
        bool needsPreSettle = rawAvailable == 0 || _getAvailableCap(_user) <= _amount;
        if (needsPreSettle && rawAvailable > 0) {
            StreamRef[] storage sRefs = _activeROIStreams[_user];
            uint256 sLen = sRefs.length;
            for (uint256 k = 0; k < sLen; ) {
                StreamRef storage sRef = sRefs[k];
                ROIStream storage s = _roiStreams[sRef.investor][sRef.lockIndex][sRef.level];
                if (!s.ended && s.recipient == _user) {
                    uint256 a = _calcAccruedRaw(s, sRef.investor, sRef.lockIndex, sRef.level);
                    if (a > 0) { s.roiPaidETH += uint128(a); _roiPendingETH[_user] += a; }
                    s.recipientSince = uint64(block.timestamp);
                }
                unchecked { k++; }
            }
        }

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
                    if (preExpiry > 0 && capRem > 0) {
                        uint256 toSettle = preExpiry < capRem ? preExpiry : capRem;
                        s.roiPaidETH          += uint128(toSettle);
                        _roiPendingETH[_user] += toSettle;
                        if (toSettle < capRem) capRem -= toSettle; else capRem = 0;
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
