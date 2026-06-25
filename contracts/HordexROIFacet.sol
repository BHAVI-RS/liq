// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./HordexStorage.sol";

/**
 * @title  HordexROIFacet — Multi-Level ROI Rewards
 * @notice Distributes Hordex's multi-level referral ROI rewards. https://hordex.club
 *
 * @dev This module powers Hordex's rewarding referral program. Each qualifying investment
 *      opens reward streams across a fixed ten-level upline, so an active, qualified community
 *      builder earns ongoing ROI from the network they help grow. Accrual is computed from the
 *      shared platform logic and accounted precisely on-chain — every reward earned is tracked
 *      and remains claimable, and amounts are recorded transparently so participants always
 *      have a clear, verifiable picture of their earnings.
 */
interface IERC20ROI {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

contract HordexROIFacet is HordexStorage {

    address private immutable _self;
    address private immutable _deployer;

    error NotDelegatecall();
    error NotDirectCall();
    error NotOwner();
    error NoETHToWithdraw();
    error ETHWithdrawFailed();
    error NoTokensToWithdraw();
    error TokenWithdrawFailed();

    constructor() {
        _self     = address(this);
        _deployer = msg.sender;
    }

    modifier onlyDelegatecall() {
        if (address(this) == _self) revert NotDelegatecall();
        _;
    }

    function _settleStream(
        ROIStream storage stream,
        address investor,
        uint256 lockIndex,
        uint8   level,
        uint256 capRemaining
    ) internal returns (uint256 settled) {
        if (stream.recipient != address(0)) {

            _absorbResume(stream, investor, lockIndex, level);

            settled = _settleHeldCarry(stream, capRemaining);
            capRemaining -= settled;
            uint256 accrued = _calcAccruedRaw(stream, investor, lockIndex, level);
            if (accrued > 0) {
                uint256 live = accrued < capRemaining ? accrued : capRemaining;
                if (live > 0) {
                    stream.roiPaidETH += uint128(live);
                    _roiPendingETH[stream.recipient] += live;
                    settled += live;
                }

                if (accrued > live) stream.historicalMissedETH += uint128(accrued - live);
            }
            stream.recipientSince = uint64(block.timestamp);
        } else {
            stream.recipientSince = uint64(block.timestamp);
        }
    }

    function _settleHeldCarry(ROIStream storage stream, uint256 capRemaining) internal returns (uint256 c) {
        if (stream.heldCarryETH > 0 && capRemaining > 0) {
            c = stream.heldCarryETH < capRemaining ? stream.heldCarryETH : capRemaining;
            stream.heldCarryETH -= uint128(c);
            stream.roiPaidETH   += uint128(c);
            _roiPendingETH[stream.recipient] += c;
        }
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

    function _naturalExpiryOf(address _user) internal view returns (uint256 lastExpiry) {

        if (_roiRetainedAt[_user] != 0) return _roiRetainedAt[_user];
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

    function _settleStreamAt(
        ROIStream storage stream,
        address investor,
        uint256 lockIndex,
        uint8   level,
        uint256 capRemaining,
        uint256 endBound
    ) internal returns (uint256 settled) {
        if (stream.recipient != address(0)) {

            _absorbResume(stream, investor, lockIndex, level);

            settled = _settleHeldCarry(stream, capRemaining);
            capRemaining -= settled;
            uint256 accrued = _calcAccruedRawAt(stream, investor, lockIndex, level, endBound);
            if (accrued > 0) {
                uint256 live = accrued < capRemaining ? accrued : capRemaining;
                if (live > 0) {
                    stream.roiPaidETH += uint128(live);
                    _roiPendingETH[stream.recipient] += live;
                    settled += live;
                }

                if (accrued > live) stream.historicalMissedETH += uint128(accrued - live);
            }
            stream.recipientSince = uint64(endBound);
        } else {
            stream.recipientSince = uint64(endBound);
        }
    }

    function initROIStreamsExt(address investor, uint256 lockIndex) external payable onlyDelegatecall {

        for (uint8 i = 0; i < 10; ) {
            ROIStream storage stream = _roiStreams[investor][lockIndex][i];
            stream.historicalPaidETH += stream.roiPaidETH;
            stream.ended          = false;
            stream.roiPaidETH     = 0;
            stream.capETH         = 0;
            stream.recipientSince = uint64(block.timestamp);
            stream.recipient      = address(0);
            unchecked { i++; }
        }

        delete _skippedROIStreams[investor][lockIndex];

        if (userLPLocks[investor][lockIndex].rewardRatePPM == 0) return;

        address cur = users[investor].referrer;
        for (uint8 i = 0; i < 10; ) {
            if (cur == address(0) || !users[cur].isRegistered) break;

            if (_activeROIStreams[cur].length < MAX_ACTIVE_ROI_STREAMS && _eligibleForLevel(cur, i)) {
                ROIStream storage stream = _roiStreams[investor][lockIndex][i];
                stream.recipient      = cur;
                stream.recipientSince = uint64(block.timestamp);
                _activeROIStreams[cur].push(StreamRef({
                    investor:  investor,
                    lockIndex: uint64(lockIndex),
                    level:     i
                }));
            } else {
                _skippedROIStreams[investor][lockIndex].push(StreamRef({
                    investor:  investor,
                    lockIndex: uint64(lockIndex),
                    level:     i
                }));
            }
            cur = users[cur].referrer;
            unchecked { i++; }
        }
    }

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

    function getROIPendingExt(address recipient) external view returns (uint256 total) {
        total = _roiPendingETH[recipient];
        StreamRef[] storage arr = _activeROIStreams[recipient];
        uint256 len = arr.length;
        for (uint256 i = 0; i < len; ) {
            StreamRef storage ref = arr[i];
            ROIStream storage stream = _roiStreams[ref.investor][ref.lockIndex][ref.level];

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

    function rescueETH() external {
        if (address(this) != _self) revert NotDirectCall();
        if (msg.sender != _deployer) revert NotOwner();
        uint256 bal = address(this).balance;
        if (bal == 0) revert NoETHToWithdraw();
        (bool ok,) = payable(_deployer).call{value: bal}("");
        if (!ok) revert ETHWithdrawFailed();
    }

    function rescueToken(address _token, uint256 amount) external {
        if (address(this) != _self) revert NotDirectCall();
        if (msg.sender != _deployer) revert NotOwner();
        uint256 bal = IERC20ROI(_token).balanceOf(address(this));
        uint256 toSend = amount == 0 ? bal : (amount > bal ? bal : amount);
        if (toSend == 0) revert NoTokensToWithdraw();
        if (!_safeTransfer(_token, _deployer, toSend)) revert TokenWithdrawFailed();
    }

    receive() external payable {}
}
