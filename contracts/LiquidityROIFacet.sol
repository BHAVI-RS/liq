// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./LiquidityStorage.sol";

// DELEGATECALL facet — executes in Liquidity.sol's storage context.
// All state accessed here is from LiquidityStorage, shared with Liquidity.sol.
// No immutables needed: ROI logic does not use Uniswap or platformToken.
contract LiquidityROIFacet is LiquidityStorage {

    uint256 private constant MAX_ROI_HOPS = 15;

    function _settleStream(
        ROIStream storage stream,
        address investor,
        uint256 lockIndex,
        uint8   level
    ) internal {
        uint256 accrued = _calcAccrued(stream, investor, lockIndex, level);
        if (accrued > 0) {
            stream.roiPaidETH      += uint128(accrued);
            _roiPendingETH[stream.recipient] += accrued;
        }
        stream.recipientSince = uint64(block.timestamp);
    }

    // Swap-and-pop removal from _activeROIStreams.
    function _removeFromActive(address who, address investor, uint64 lockIndex, uint8 level) internal {
        StreamRef[] storage arr = _activeROIStreams[who];
        uint256 len = arr.length;
        for (uint256 i = 0; i < len; ) {
            StreamRef storage r = arr[i];
            if (r.investor == investor && r.lockIndex == lockIndex && r.level == level) {
                arr[i] = arr[len - 1];
                arr.pop();
                return;
            }
            unchecked { i++; }
        }
    }

    // ── External (DELEGATECALL) mutators ──────────────────────────────────────

    // Called from Liquidity.sol's invest() after the LP lock is pushed.
    function initROIStreamsExt(address investor, uint256 lockIndex) external payable {
        LPLock storage lock = userLPLocks[investor][lockIndex];
        uint256 capBase = lock.ethInvested;

        address startRef = users[investor].referrer;
        for (uint8 i = 0; i < 10; ) {
            ROIStream storage stream = _roiStreams[investor][lockIndex][i];

            // Reset (handles restake re-init on same lockIndex)
            stream.ended          = false;
            stream.roiPaidETH     = 0;
            stream.capETH         = uint128(capBase * referralCommissionRates[i] / 10_000);
            stream.recipientSince = uint64(block.timestamp);

            // Walk up chain; track skipped (ineligible) people
            address current   = startRef;
            uint256 hops      = 0;
            address eligible  = address(0);
            while (current != address(0) && users[current].isRegistered && hops < MAX_ROI_HOPS) {
                unchecked { hops++; }
                if (activeReferralCount[current] > i || current == owner) {
                    eligible = current;
                    break;
                }
                _skippedROIStreams[current][i].push(StreamRef({
                    investor:  investor,
                    lockIndex: uint64(lockIndex),
                    level:     i
                }));
                current = users[current].referrer;
            }
            if (eligible == address(0)) eligible = owner;

            stream.recipient = eligible;
            _activeROIStreams[eligible].push(StreamRef({
                investor:  investor,
                lockIndex: uint64(lockIndex),
                level:     i
            }));
            unchecked { i++; }
        }
    }

    // Called from Liquidity.sol's _removeLPCore() before onLossReferralExt.
    function endROIStreamsExt(address investor, uint256 lockIndex) external payable {
        for (uint8 i = 0; i < 10; ) {
            ROIStream storage stream = _roiStreams[investor][lockIndex][i];
            if (!stream.ended) {
                _settleStream(stream, investor, lockIndex, i);
                _removeFromActive(stream.recipient, investor, uint64(lockIndex), i);
                stream.ended     = true;
                stream.recipient = address(0);
            }
            unchecked { i++; }
        }
    }

    // Called after activeReferralCount[referrer] has been incremented.
    function onGainReferralExt(address referrer) external payable {
        uint256 cnt = activeReferralCount[referrer];
        if (cnt == 0) return;
        uint8 newLevel = uint8(cnt - 1);

        StreamRef[] storage skipped = _skippedROIStreams[referrer][newLevel];
        uint256 len = skipped.length;
        for (uint256 i = 0; i < len; ) {
            StreamRef memory ref = skipped[i];
            ROIStream storage stream = _roiStreams[ref.investor][ref.lockIndex][ref.level];
            unchecked { i++; }
            if (stream.ended) continue;

            // Settle to current recipient, then redirect to referrer
            _settleStream(stream, ref.investor, ref.lockIndex, ref.level);
            _removeFromActive(stream.recipient, ref.investor, ref.lockIndex, ref.level);

            stream.recipient      = referrer;
            stream.recipientSince = uint64(block.timestamp);
            _activeROIStreams[referrer].push(ref);
        }
        delete _skippedROIStreams[referrer][newLevel];
    }

    // Called after activeReferralCount[referrer] has been decremented.
    function onLossReferralExt(address referrer) external payable {
        uint8 lostLevel = uint8(activeReferralCount[referrer]); // new count = lost level (0-indexed)

        StreamRef[] storage active = _activeROIStreams[referrer];
        uint256 i = 0;
        while (i < active.length) {
            StreamRef memory ref = active[i];
            ROIStream storage stream = _roiStreams[ref.investor][ref.lockIndex][ref.level];

            if (stream.ended || ref.level != lostLevel) {
                unchecked { i++; }
                continue;
            }

            // Settle accrued to referrer
            _settleStream(stream, ref.investor, ref.lockIndex, ref.level);

            // Find next eligible above referrer
            address current      = users[referrer].referrer;
            uint256 hops         = 0;
            address nextEligible = address(0);
            while (current != address(0) && users[current].isRegistered && hops < MAX_ROI_HOPS) {
                unchecked { hops++; }
                if (activeReferralCount[current] > lostLevel || current == owner) {
                    nextEligible = current;
                    break;
                }
                _skippedROIStreams[current][lostLevel].push(ref);
                current = users[current].referrer;
            }
            if (nextEligible == address(0)) nextEligible = owner;

            stream.recipient      = nextEligible;
            stream.recipientSince = uint64(block.timestamp);
            _activeROIStreams[nextEligible].push(ref);

            // Record that referrer was skipped (so they can reclaim when eligible again)
            _skippedROIStreams[referrer][lostLevel].push(ref);

            // Swap-and-pop
            active[i] = active[active.length - 1];
            active.pop();
            // don't increment i
        }
    }

    // Settle all active streams for recipient into _roiPendingETH.
    // Called from Liquidity.sol's claimAllROI() before reading _roiPendingETH.
    function settleAllStreamsExt(address recipient) external payable {
        StreamRef[] storage arr = _activeROIStreams[recipient];
        uint256 len = arr.length;
        for (uint256 i = 0; i < len; ) {
            StreamRef storage ref = arr[i];
            ROIStream storage stream = _roiStreams[ref.investor][ref.lockIndex][ref.level];
            if (!stream.ended) {
                _settleStream(stream, ref.investor, ref.lockIndex, ref.level);
            }
            unchecked { i++; }
        }
    }

    // Settle a single stream for the caller (used by claimROIFromStream).
    function settleStreamExt(address investor, uint256 lockIndex, uint8 level) external payable {
        ROIStream storage stream = _roiStreams[investor][lockIndex][level];
        if (!stream.ended && stream.recipient == msg.sender) {
            _settleStream(stream, investor, lockIndex, level);
        }
    }

    // ── View functions ────────────────────────────────────────────────────────

    // Returns pending + all unsettled active streams for recipient.
    function getROIPendingExt(address recipient) external view returns (uint256 total) {
        total = _roiPendingETH[recipient];
        StreamRef[] storage arr = _activeROIStreams[recipient];
        uint256 len = arr.length;
        for (uint256 i = 0; i < len; ) {
            StreamRef storage ref = arr[i];
            ROIStream storage stream = _roiStreams[ref.investor][ref.lockIndex][ref.level];
            if (!stream.ended) {
                total += _calcAccrued(stream, ref.investor, ref.lockIndex, ref.level);
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
        ROIStream storage stream = _roiStreams[investor][lockIndex][level];
        return _calcAccrued(stream, investor, lockIndex, level);
    }
}
