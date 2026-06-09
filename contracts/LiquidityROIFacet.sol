// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./LiquidityStorage.sol";

// DELEGATECALL facet — executes in Liquidity.sol's storage context.
// _calcAccrued is inherited from LiquidityStorage.
//
// Fixed 10-level assignment: level i always goes to the (i+1)-th ancestor in the
// referral chain above the investor (direct referrer = level 0).  Every position is
// filled regardless of eligibility — ineligible recipients simply don't accumulate
// (enforced by _calcAccrued).  No dynamic re-routing, no deferred queues.
contract LiquidityROIFacet is LiquidityStorage {

    address private immutable _self;

    error NotDelegatecall();

    constructor() {
        _self = address(this);
    }

    modifier onlyDelegatecall() {
        if (address(this) == _self) revert NotDelegatecall();
        _;
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    // Settles a single stream using raw accrual (no cap gate).
    // The caller is responsible for enforcing the raw cap ceiling across the batch.
    // toSettle = 0 is valid: recipientSince is always reset so future accrual starts fresh.
    function _settleStream(
        ROIStream storage stream,
        address investor,
        uint256 lockIndex,
        uint8   level,
        uint256 capRemaining    // max ETH this settlement may add to pending (0 = skip payment)
    ) internal returns (uint256 settled) {
        if (stream.recipient != address(0) && capRemaining > 0) {
            uint256 accrued = _calcAccruedRaw(stream, investor, lockIndex, level);
            settled = accrued < capRemaining ? accrued : capRemaining;
            if (settled > 0) {
                stream.roiPaidETH += uint128(settled);
                _roiPendingETH[stream.recipient] += settled;
            }
        }
        stream.recipientSince = uint64(block.timestamp);
    }

    function _removeFromActive(address who, address investor, uint64 lockIndex, uint8 level) internal {
        StreamRef[] storage arr = _activeROIStreams[who];
        uint256 len = arr.length;
        for (uint256 i = 0; i < len; ) {
            if (arr[i].investor == investor && arr[i].lockIndex == lockIndex && arr[i].level == level) {
                arr[i] = arr[len - 1];
                arr.pop();
                return;
            }
            unchecked { i++; }
        }
    }

    // Returns the latest expired LP lock timestamp for a user whose cap has expired naturally
    // (all locks past unlockTime, _capPausedAt not set). Returns 0 if cap is paused or still active.
    // Used to bound claim settlements so gap-period ROI is not paid out.
    function _naturalExpiryOf(address _user) internal view returns (uint256 lastExpiry) {
        if (_capPausedAt[_user] != 0) return 0;
        if (_getRawAvailableCap(_user) != 0) return 0;
        LPLock[] storage locks = userLPLocks[_user];
        uint256 len = locks.length;
        for (uint256 j = 0; j < len; ) {
            LPLock storage l = locks[j];
            if (!l.removed && l.unlockTime <= block.timestamp && l.unlockTime > lastExpiry) {
                lastExpiry = l.unlockTime;
            }
            unchecked { j++; }
        }
    }

    // Like _settleStream but bounded to endBound — used when A's own lock has expired naturally.
    // Sets recipientSince = endBound (not block.timestamp) so _handleNaturalExpiryResume can
    // later detect the gap period (endBound → reinvestment time) and record it as missed.
    function _settleStreamAt(
        ROIStream storage stream,
        address investor,
        uint256 lockIndex,
        uint8   level,
        uint256 capRemaining,
        uint256 endBound
    ) internal returns (uint256 settled) {
        if (stream.recipient != address(0) && capRemaining > 0) {
            uint256 accrued = _calcAccruedRawAt(stream, investor, lockIndex, level, endBound);
            settled = accrued < capRemaining ? accrued : capRemaining;
            if (settled > 0) {
                stream.roiPaidETH += uint128(settled);
                _roiPendingETH[stream.recipient] += settled;
            }
        }
        stream.recipientSince = uint64(endBound);
    }

    // ── External (DELEGATECALL) mutators ──────────────────────────────────────

    // Called by invest() after the LP lock is pushed, and by restakeLP() after endROIStreamsExt.
    // Assigns level i to the (i+1)-th ancestor in the referral chain (0 = direct referrer).
    // All 10 slots are filled up to wherever the chain ends; empty slots have recipient = address(0).
    function initROIStreamsExt(address investor, uint256 lockIndex) external payable onlyDelegatecall {
        // Reset all 10 streams for this lock period.
        for (uint8 i = 0; i < 10; ) {
            ROIStream storage stream = _roiStreams[investor][lockIndex][i];
            stream.historicalPaidETH += stream.roiPaidETH; // preserve history across restakes
            stream.ended          = false;
            stream.roiPaidETH     = 0;
            stream.capETH         = 0;
            stream.recipientSince = uint64(block.timestamp);
            stream.recipient      = address(0);
            unchecked { i++; }
        }

        // Walk exactly 10 levels up the referral chain; assign whoever is there.
        address cur = users[investor].referrer;
        for (uint8 i = 0; i < 10; ) {
            if (cur == address(0) || !users[cur].isRegistered) break;
            ROIStream storage stream = _roiStreams[investor][lockIndex][i];
            stream.recipient      = cur;
            stream.recipientSince = uint64(block.timestamp);
            _activeROIStreams[cur].push(StreamRef({
                investor:  investor,
                lockIndex: uint64(lockIndex),
                level:     i
            }));
            cur = users[cur].referrer;
            unchecked { i++; }
        }
    }

    // Called by _removeLPCore() and restakeLP() before initROIStreamsExt.
    // Settles each stream's pending accrual (capped at recipient's live available cap) and marks it ended.
    function endROIStreamsExt(address investor, uint256 lockIndex) external payable onlyDelegatecall {
        for (uint8 i = 0; i < 10; ) {
            ROIStream storage stream = _roiStreams[investor][lockIndex][i];
            if (!stream.ended) {
                address recip = stream.recipient;
                uint256 capRem = 0;
                if (recip != address(0)) {
                    uint256 rawCap = _getRawAvailableCap(recip);
                    uint256 alreadyPending = _roiPendingETH[recip];
                    capRem = rawCap > alreadyPending ? rawCap - alreadyPending : 0;
                }
                _settleStream(stream, investor, lockIndex, i, capRem);
                if (recip != address(0)) {
                    _removeFromActive(recip, investor, uint64(lockIndex), i);
                }
                stream.ended     = true;
                stream.recipient = address(0);
            }
            unchecked { i++; }
        }
    }

    // Settle all active streams for recipient into _roiPendingETH, capped at available cap.
    // When cap is paused (_capPausedAt > 0): uses active-only cap (= 0) — streams were already
    // pre-settled by _chargeCap; post-exhaustion accrual must not be settled.
    // When cap is NOT paused but active locks expired: uses settlement cap (incl. expired locks)
    // so ROI earned during the lock period can still be collected.
    // When A's lock expired naturally (no _capPausedAt), bounds each stream's settlement at
    // _naturalExpiryOf(recipient) so gap-period ROI (expiry → now) is not paid out.
    // Existing _roiPendingETH is deducted from capRem so settlement never pushes pending above cap.
    // Called by claimAllROI() before reading _roiPendingETH.
    function settleAllStreamsExt(address recipient) external payable onlyDelegatecall {
        uint256 naturalExpiry = _naturalExpiryOf(recipient);
        uint256 rawCap = _capPausedAt[recipient] > 0
            ? _getRawAvailableCap(recipient)
            : _getRawAvailableCapInclExpired(recipient);
        uint256 alreadyPending = _roiPendingETH[recipient];
        uint256 capRem = rawCap > alreadyPending ? rawCap - alreadyPending : 0;
        StreamRef[] storage arr = _activeROIStreams[recipient];
        uint256 len = arr.length;
        for (uint256 i = 0; i < len; ) {
            StreamRef storage ref = arr[i];
            ROIStream storage stream = _roiStreams[ref.investor][ref.lockIndex][ref.level];
            if (!stream.ended) {
                uint256 s = naturalExpiry > 0
                    ? _settleStreamAt(stream, ref.investor, ref.lockIndex, ref.level, capRem, naturalExpiry)
                    : _settleStream(stream, ref.investor, ref.lockIndex, ref.level, capRem);
                if (s < capRem) { capRem -= s; } else { capRem = 0; }
            }
            unchecked { i++; }
        }
    }

    // Settles a range of active streams [fromIndex, fromIndex+count) into _roiPendingETH.
    function settleStreamsRangeExt(address recipient, uint256 fromIndex, uint256 count) external payable onlyDelegatecall {
        uint256 naturalExpiry = _naturalExpiryOf(recipient);
        uint256 rawCap = _capPausedAt[recipient] > 0
            ? _getRawAvailableCap(recipient)
            : _getRawAvailableCapInclExpired(recipient);
        uint256 alreadyPending = _roiPendingETH[recipient];
        uint256 capRem = rawCap > alreadyPending ? rawCap - alreadyPending : 0;
        StreamRef[] storage arr = _activeROIStreams[recipient];
        uint256 len = arr.length;
        uint256 end = fromIndex + count;
        if (end > len) end = len;
        for (uint256 i = fromIndex; i < end; ) {
            StreamRef storage ref = arr[i];
            ROIStream storage stream = _roiStreams[ref.investor][ref.lockIndex][ref.level];
            if (!stream.ended) {
                uint256 s = naturalExpiry > 0
                    ? _settleStreamAt(stream, ref.investor, ref.lockIndex, ref.level, capRem, naturalExpiry)
                    : _settleStream(stream, ref.investor, ref.lockIndex, ref.level, capRem);
                if (s < capRem) { capRem -= s; } else { capRem = 0; }
            }
            unchecked { i++; }
        }
    }

    // Settle a single stream for msg.sender (called by claimROIFromStream).
    function settleStreamExt(address investor, uint256 lockIndex, uint8 level) external payable onlyDelegatecall {
        ROIStream storage stream = _roiStreams[investor][lockIndex][level];
        if (!stream.ended && stream.recipient == msg.sender) {
            uint256 naturalExpiry = _naturalExpiryOf(msg.sender);
            uint256 rawCap = _capPausedAt[msg.sender] > 0
                ? _getRawAvailableCap(msg.sender)
                : _getRawAvailableCapInclExpired(msg.sender);
            uint256 alreadyPending = _roiPendingETH[msg.sender];
            uint256 capRem = rawCap > alreadyPending ? rawCap - alreadyPending : 0;
            if (naturalExpiry > 0) {
                _settleStreamAt(stream, investor, lockIndex, level, capRem, naturalExpiry);
            } else {
                _settleStream(stream, investor, lockIndex, level, capRem);
            }
        }
    }

    // ── View functions ────────────────────────────────────────────────────────

    function getROIPendingExt(address recipient) external view returns (uint256 total) {
        total = _roiPendingETH[recipient];
        StreamRef[] storage arr = _activeROIStreams[recipient];
        uint256 len = arr.length;
        for (uint256 i = 0; i < len; ) {
            StreamRef storage ref = arr[i];
            ROIStream storage stream = _roiStreams[ref.investor][ref.lockIndex][ref.level];
            // Raw accrual: returns full amount regardless of cap state, matching getROIData.
            if (!stream.ended) {
                total += _calcAccruedRaw(stream, ref.investor, ref.lockIndex, ref.level);
            }
            unchecked { i++; }
        }
    }

    function getActiveROIStreamsExt(address recipient) external view returns (StreamRef[] memory) {
        return _activeROIStreams[recipient];
    }

    function getROIStreamInfoExt(address investor, uint256 lockIndex, uint8 level)
        external view returns (ROIStream memory)
    {
        return _roiStreams[investor][lockIndex][level];
    }

    function getROIAccruedExt(address investor, uint256 lockIndex, uint8 level)
        external view returns (uint256)
    {
        return _calcAccruedRaw(_roiStreams[investor][lockIndex][level], investor, lockIndex, level);
    }
}
