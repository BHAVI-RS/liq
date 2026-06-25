// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./HordexTypes.sol";

/**
 * @title  HordexStorage — Shared Platform State
 * @notice The foundational on-chain state layout for the Hordex platform. https://hordex.club
 *
 * @dev Hordex uses a modular architecture: a compact core contract paired with focused,
 *      upgrade-friendly modules that all operate over this one shared state. Centralizing the
 *      layout here keeps every module perfectly consistent and makes the platform's entire
 *      footprint — users, liquidity locks, staking configuration, ROI reward streams, and a
 *      rich set of on-chain history records — transparent and auditable directly from chain
 *      state. It also hosts the shared reward-accrual logic so reward accounting is computed
 *      identically everywhere it is used.
 */
abstract contract HordexStorage {

    mapping(address => User)    public users;
    mapping(address => uint256) public userTotalInvested;
    address public featuredToken;
    address public owner;

    uint16[10] public referralCommissionRates;
    uint256    public minDirectReferralInvestment;

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

    uint32[12]          internal investmentTiers;
    uint16[6]           internal stakingDurations;
    uint256[4][12][6]   internal stakingRates;

    bool internal _locked;

    mapping(address => PriceSnap[])        internal _priceHistory;
    mapping(address => TradeSnap[])        internal _tradeHistory;
    mapping(address => CommissionRecord[]) internal _commissionRecords;
    mapping(address => InvestRecord[])     internal _investRecords;
    mapping(address => ClaimRecord[])      internal _claimRecords;
    mapping(address => LPEventRecord[])    internal _lpEventRecords;

    mapping(address => mapping(uint256 => LockPeriod[])) internal _lockPeriods;

    mapping(address => mapping(uint256 => ROIStream[10])) internal _roiStreams;
    mapping(address => StreamRef[])                        internal _activeROIStreams;
    mapping(address => mapping(uint256 => StreamRef[]))   internal _skippedROIStreams;
    mapping(address => uint256)                           internal _roiPendingETH;

    mapping(address => StreamRef[])                        internal _deferredROIStreams;

    uint256 internal constant MAX_ACTIVE_ROI_STREAMS = 5000;

    function _qualifies(address _user) internal view returns (bool) {
        uint256 total = userTotalInvested[_user];
        return total > 0 && (minDirectReferralInvestment == 0 || total >= minDirectReferralInvestment);
    }

    function _syncReferralCount(address user) internal {
        address ref = users[user].referrer;
        if (ref == address(0)) return;
        bool nowQ    = _qualifies(user);
        bool counted = _countsForReferrer[user];
        if (nowQ == counted) return;
        if (nowQ) {
            _countsForReferrer[user] = true;
            activeReferralCount[ref]++;
        } else {
            _countsForReferrer[user] = false;
            if (activeReferralCount[ref] > 0) activeReferralCount[ref]--;
        }
    }

    uint256 internal constant _ROI_DENOM         = 50_000_000_000;

    uint256 internal constant _ROI_LOCK_DURATION = 90 * SECONDS_PER_DAY;

    function _calcAccrued(
        ROIStream storage stream,
        address investor,
        uint256 lockIndex,
        uint8   level
    ) internal view returns (uint256 accrued) {
        if (stream.ended || stream.recipient == address(0)) return 0;

        if (stream.recipient != owner && !_qualifies(stream.recipient)) return 0;

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

    mapping(address => ClaimRecord[]) internal _roiClaimRecords;

    mapping(address => uint256) internal _totalLockedLP;

    mapping(address => TwapObs) internal _tokenTwapObs0;
    mapping(address => TwapObs) internal _tokenTwapObs1;
    mapping(address => uint256) internal _tokenTwapPrice;
    mapping(address => uint256) internal _tokenTwapLastUpdated;
    mapping(address => bool)    internal _tokenTwapReady;

    mapping(address => uint256) public totalMissedCommissions;

    mapping(address => MissedRecord[]) internal _missedRecords;

    uint16[10] public roiCommissionRates;

    mapping(address => uint64) internal _capPausedAt;

    mapping(address => bool) internal _countsForReferrer;

    mapping(address => uint256) internal _roiRetainedCap;
    mapping(address => uint64)  internal _roiRetainedAt;

    mapping(address => uint256) internal _roiResumeBoundary;
    mapping(address => uint256) internal _roiResumeAt;
    mapping(address => uint256) internal _roiUnabsorbed;

    uint32[10] internal selfStakeGate;
    uint32[10] internal businessGate;
    mapping(address => uint256) internal _teamBusinessUSDT;

    function _activeSelfStakeWei(address _user) internal view returns (uint256 sumWei) {
        LPLock[] storage locks = userLPLocks[_user];
        uint256 len = locks.length;
        for (uint256 j = 0; j < len; ) {
            LPLock storage l = locks[j];
            if (!l.removed && block.timestamp < l.unlockTime) sumWei += l.ethInvested;
            unchecked { j++; }
        }
    }

    function _activeSelfStakeUSDT(address _user) internal view returns (uint256) {
        return _activeSelfStakeWei(_user) / USDT_ONE;
    }

    function _eligibleForLevel(address _user, uint8 level) internal view returns (bool) {
        if (_user == owner) return true;
        return _activeSelfStakeUSDT(_user) >= selfStakeGate[level];
    }

    function _eligibleForReferralLevel(address _user, uint8 ) internal view returns (bool) {
        if (_user == owner) return true;
        return _activeSelfStakeUSDT(_user) >= selfStakeGate[0];
    }

    function _resumeAdjustedElapsed(
        address recipient, uint256 recipientSince, uint256 startTs, uint256 endTs
    ) private view returns (uint256 elapsed) {
        elapsed = endTs - startTs;
        uint256 T = _roiResumeAt[recipient];
        if (T == 0 || recipientSince >= T) return elapsed;
        uint256 E  = _roiResumeBoundary[recipient];
        uint256 lo = startTs > E ? startTs : E;
        uint256 hi = endTs   < T ? endTs   : T;
        if (hi > lo) elapsed -= (hi - lo);
    }

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

        uint256 preEnd = E < lockEnd ? E : lockEnd;
        if (preEnd > startTs) {
            uint256 pe = lock.ethInvested * lock.rewardRatePPM * (preEnd - startTs) * rate / (_ROI_DENOM * lockDur);
            if (pe > 0) stream.heldCarryETH += uint128(pe);
        }

        uint256 gLo = startTs > E ? startTs : E;
        uint256 gHi = T < lockEnd ? T : lockEnd;
        if (gHi > gLo) {
            uint256 gp = lock.ethInvested * lock.rewardRatePPM * (gHi - gLo) * rate / (_ROI_DENOM * lockDur);
            if (gp > 0) stream.historicalMissedETH += uint128(gp);
        }

        stream.recipientSince = uint64(T);
        if (_roiUnabsorbed[recip] > 0) _roiUnabsorbed[recip]--;
    }

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

        available += _roiRetainedCap[_user];
    }

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

        if (remaining > 0 && _roiRetainedCap[_user] > 0) {
            uint256 r = remaining < _roiRetainedCap[_user] ? remaining : _roiRetainedCap[_user];
            _roiRetainedCap[_user] -= r;
        }
    }

    function _claimableCap(address _user) internal view returns (uint256) {
        return _capPausedAt[_user] > 0 ? _getRawAvailableCap(_user) : _getRawAvailableCapInclExpired(_user);
    }

    function _chargeClaimCap(address _user, uint256 _amount) internal {
        uint256 activeCap    = _getRawAvailableCap(_user);
        uint256 chargeActive = _amount < activeCap ? _amount : activeCap;
        if (chargeActive > 0) _chargeCap(_user, chargeActive);
        uint256 chargeExpired = _amount - chargeActive;
        if (chargeExpired > 0) _chargeCapInclExpired(_user, chargeExpired);
    }

    function _calcAccruedRaw(
        ROIStream storage stream,
        address investor,
        uint256 lockIndex,
        uint8   level
    ) internal view returns (uint256 accrued) {
        if (stream.ended || stream.recipient == address(0)) return 0;

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

    function _getAvailableCap(address _user) internal view returns (uint256) {
        return _availFromRaw(_user, _getRawAvailableCap(_user));
    }

    function _getAvailableCapInclExpired(address _user) internal view returns (uint256) {
        return _availFromRaw(_user, _getRawAvailableCapInclExpired(_user));
    }

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

    function _getCommissionCap(address _user) internal view returns (uint256) {
        uint256 raw  = _getRawAvailableCap(_user);
        uint256 pend = _roiPendingETH[_user];
        return raw > pend ? raw - pend : 0;
    }

    function _chargeCap(address _user, uint256 _amount) internal {

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

            _capPausedAt[_user] = uint64(block.timestamp);
        }
    }

    function _handleNaturalExpiryResume(address _user, uint256 lastExpiry) internal {
        if (lastExpiry == 0) return;
        if (_roiResumeAt[_user] != 0 && _roiUnabsorbed[_user] > 0) {
            _drainPendingResume(_user);
        }
        _roiResumeBoundary[_user] = lastExpiry;
        _roiResumeAt[_user]       = block.timestamp;
        _roiUnabsorbed[_user]     = _activeROIStreams[_user].length;
    }

    mapping(address => ReserveTranche[]) internal _reserveTranches;
    mapping(address => uint256)          internal _reserveTotalWei;

    bool internal _paused;

    function _pushReserveTranche(address _user, uint256 _netAmount, uint64 _unlockTime) internal {
        _reserveTranches[_user].push(ReserveTranche({
            amount:     uint128(_netAmount),
            unlockTime: _unlockTime
        }));
        _reserveTotalWei[_user] += _netAmount;
    }

    function _reserveClaimableWei(address _user) internal view returns (uint256 sum) {
        ReserveTranche[] storage tr = _reserveTranches[_user];
        uint256 n = tr.length;
        for (uint256 i = 0; i < n; ) {
            if (block.timestamp >= tr[i].unlockTime) sum += tr[i].amount;
            unchecked { i++; }
        }
    }

    function _consumeMaturedReserve(address _user) internal returns (uint256 claimed) {
        ReserveTranche[] storage tr = _reserveTranches[_user];
        uint256 n = tr.length;
        uint256 write = 0;
        for (uint256 read = 0; read < n; ) {
            ReserveTranche memory cur = tr[read];
            if (block.timestamp >= cur.unlockTime) {
                claimed += cur.amount;
            } else {
                if (write != read) tr[write] = cur;
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

    function _consumeReserve(address _user, uint256 _amount) internal {
        ReserveTranche[] storage tr = _reserveTranches[_user];
        uint256 n = tr.length;
        uint256 remaining = _amount;
        uint256 write = 0;
        for (uint256 read = 0; read < n; ) {
            ReserveTranche memory cur = tr[read];
            if (remaining == 0) {
                if (write != read) tr[write] = cur;
                unchecked { write++; }
            } else if (cur.amount <= remaining) {
                remaining -= cur.amount;
            } else {
                cur.amount = uint128(cur.amount - remaining);
                remaining  = 0;
                tr[write]  = cur;
                unchecked { write++; }
            }
            unchecked { read++; }
        }
        while (tr.length > write) tr.pop();
        _reserveTotalWei[_user] -= _amount;
    }

    function _safeTransfer(address token, address to, uint256 value) internal returns (bool) {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        return ok && (data.length == 0 || abi.decode(data, (bool)));
    }
    function _safeTransferFrom(address token, address from, address to, uint256 value) internal returns (bool) {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, value));
        return ok && (data.length == 0 || abi.decode(data, (bool)));
    }
}
