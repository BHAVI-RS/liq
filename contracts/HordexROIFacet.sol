// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./HordexStorage.sol";

interface IERC20ROI {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

// DELEGATECALL facet — executes in Hordex.sol's storage context.
// _calcAccrued is inherited from HordexStorage.
//
// Fixed 10-level assignment: level i always goes to the (i+1)-th ancestor in the
// referral chain above the investor (direct referrer = level 0).  Every position is
// filled regardless of eligibility — ineligible recipients simply don't accumulate
// (enforced by _calcAccrued).  No dynamic re-routing, no deferred queues.
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

    // ── Internal helpers ──────────────────────────────────────────────────────

    // Settles a single stream using raw accrual (no cap gate).
    // The caller is responsible for enforcing the raw cap ceiling across the batch.
    // Any accrual that cannot be settled (capRemaining = 0 or cap too small) is recorded
    // directly into stream.historicalMissedETH so the value is never silently discarded.
    function _settleStream(
        ROIStream storage stream,
        address investor,
        uint256 lockIndex,
        uint8   level,
        uint256 capRemaining    // max ETH this settlement may add to pending (0 = record all as missed)
    ) internal returns (uint256 settled) {
        if (stream.recipient != address(0)) {
            // Lazily reconcile any pending natural-expiry resume for this stream first: banks the
            // pre-expiry earned ROI as held-carry (drained into pending just below) and forfeits the
            // no-stake gap. After this, recipientSince is at the resume time so _calcAccruedRaw is
            // clean live accrual — identical to the old eager-resume result, just deferred.
            _absorbResume(stream, investor, lockIndex, level);
            // Settle carried-over held first (over-cap preserved from a prior natural-expiry restake).
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
                // Over-cap ROI (accrued − live) accruing while the lock is still locked is FORFEITED
                // as MISSED — NOT held. Record it and advance recipientSince fully so it can never be
                // re-accrued or claimed later (not even after re-investing to regain cap).
                if (accrued > live) stream.historicalMissedETH += uint128(accrued - live);
            }
            stream.recipientSince = uint64(block.timestamp);
        } else {
            stream.recipientSince = uint64(block.timestamp);
        }
    }

    // Draws down a stream's carried-over held ROI into pending, up to capRemaining. Returns the
    // amount settled so callers can decrement their running cap budget.
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

    // Returns the latest expired LP lock timestamp for a user whose cap has expired naturally
    // (all locks past unlockTime, _capPausedAt not set). Returns 0 if cap is paused or still active.
    // Used to bound claim settlements so gap-period ROI is not paid out.
    function _naturalExpiryOf(address _user) internal view returns (uint256 lastExpiry) {
        // Retained (withdrawn-but-cap-preserved) users: bound earned ROI at the retention time
        // (the removed lock's expiry) so post-exit / gap ROI is never settled.
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

    // Like _settleStream but bounded to endBound — used when A's own lock has expired naturally.
    // Sets recipientSince = endBound (not block.timestamp) so _handleNaturalExpiryResume can
    // later detect the gap period (endBound → reinvestment time) and record it as missed.
    // Any accrual that cannot be settled (cap insufficient) is written to historicalMissedETH.
    function _settleStreamAt(
        ROIStream storage stream,
        address investor,
        uint256 lockIndex,
        uint8   level,
        uint256 capRemaining,
        uint256 endBound
    ) internal returns (uint256 settled) {
        if (stream.recipient != address(0)) {
            // Reconcile any pending natural-expiry resume first (see _settleStream for rationale).
            _absorbResume(stream, investor, lockIndex, level);
            // Settle carried-over held first (over-cap preserved from a prior natural-expiry restake).
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
                // Over-cap ROI is FORFEITED as MISSED (not held) — same rule as _settleStream,
                // bounded at endBound. recipientSince advances fully so it never re-accrues.
                if (accrued > live) stream.historicalMissedETH += uint128(accrued - live);
            }
            stream.recipientSince = uint64(endBound);
        } else {
            stream.recipientSince = uint64(endBound);
        }
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
        // Recompute this lock's skip-log from scratch for the new period (bounded: it only ever
        // holds the current period's overflow levels).
        delete _skippedROIStreams[investor][lockIndex];

        // Skip recipient assignment entirely for locks that earn no staking reward (package < $100,
        // so rewardRatePPM == 0). ROI accrual is rewardRatePPM-proportional (_calcAccrued), so these
        // streams can never pay out — assigning them would only park dead, zero-yield entries in each
        // upline's _activeROIStreams, consuming MAX_ACTIVE_ROI_STREAMS slots and settlement-loop gas
        // for nothing. The streams stay inert (recipient = address(0)); _calcAccrued returns 0 anyway,
        // and a later restake into a >=$100 amount is impossible (ethInvested never changes), so this
        // never withholds a stream that could have earned. Everything else (LP lock, staking, referral
        // cash commissions, cap) proceeds normally.
        if (userLPLocks[investor][lockIndex].rewardRatePPM == 0) return;

        // Walk exactly 10 levels up the referral chain; assign whoever is there.
        address cur = users[investor].referrer;
        for (uint8 i = 0; i < 10; ) {
            if (cur == address(0) || !users[cur].isRegistered) break;
            // Bound the recipient's live-stream array at MAX_ACTIVE_ROI_STREAMS so every
            // per-recipient loop stays O(M) and invest()/claim gas can never exceed the block
            // limit no matter how large the downline grows. Over the cap the level is recorded as
            // skipped and left INERT — recipient stays address(0): no accrual (_calcAccrued* returns
            // 0), not enumerated, not claimable. A restake re-runs this assignment, so a skipped
            // level can become live later once the recipient's active slots free up.
            // Eligibility gate: assign this level's stream only to an ancestor who currently meets
            // the level's self-stake + team-business gates. An ineligible ancestor is recorded as
            // skipped (inert) — a later restake re-runs assignment, so the level can become live once
            // the ancestor qualifies. (Slot overflow is handled by the same skipped path.)
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

    // Called by _removeLPCore() and restakeLP() before initROIStreamsExt.
    // Settles each stream's pending accrual (capped at recipient's live available cap) and marks it ended.
    // Any unsettled accrual is recorded as missed inside _settleStream.
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

    // ── Emergency rescue (direct calls only, deployer only) ───────────────────

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
        if (!IERC20ROI(_token).transfer(_deployer, toSend)) revert TokenWithdrawFailed();
    }

    receive() external payable {}
}
