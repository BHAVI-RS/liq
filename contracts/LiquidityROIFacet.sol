// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./LiquidityStorage.sol";

// DELEGATECALL facet — executes in Liquidity.sol's storage context.
// _calcAccrued is inherited from LiquidityStorage.
//
// One-stream-per-lock rule: for a given investor's LP lock, each address in the
// referral chain accumulates at most ONE level's ROI at any moment.  The level
// assigned is always the LOWEST (highest-rate) available to them.
//
// Assignment always re-walks from the investor's direct referrer (Option B), so
// a closer-to-investor eligible person can never end up with a lower rate than
// a farther one.
contract LiquidityROIFacet is LiquidityStorage {

    uint256 private constant MAX_ROI_HOPS = 15;

    // ── Low-level storage helpers ─────────────────────────────────────────────

    function _settleStream(
        ROIStream storage stream,
        address investor,
        uint256 lockIndex,
        uint8   level
    ) internal {
        if (stream.recipient != address(0)) {
            uint256 accrued = _calcAccrued(stream, investor, lockIndex, level);
            if (accrued > 0) {
                stream.roiPaidETH += uint128(accrued);
                _roiPendingETH[stream.recipient] += accrued;
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

    // True if `person` (non-owner) is currently the active recipient of any stream
    // at a level LOWER than `level` from this specific lock.
    function _holdsLowerLevel(address investor, uint64 lockIndex, uint8 level, address person)
        internal view returns (bool)
    {
        for (uint8 j = 0; j < level; ) {
            ROIStream storage s = _roiStreams[investor][lockIndex][j];
            if (!s.ended && s.recipient == person) return true;
            unchecked { j++; }
        }
        return false;
    }

    // Returns the level currently held by `person` from this lock.
    // Returns 255 (sentinel) if person holds no stream from this lock.
    function _getHeldLevel(address investor, uint64 lockIndex, address person)
        internal view returns (uint8)
    {
        for (uint8 j = 0; j < 10; ) {
            ROIStream storage s = _roiStreams[investor][lockIndex][j];
            if (!s.ended && s.recipient == person) return j;
            unchecked { j++; }
        }
        return type(uint8).max;
    }

    // Find the lowest deferred entry for `person` from (investor, lockIndex)
    // where entry.level > minLevel.  Returns (found, level, arrayIndex).
    function _findLowestDeferred(
        address person, address investor, uint64 lockIndex, uint8 minLevel
    ) internal view returns (bool found, uint8 lvl, uint256 idx) {
        StreamRef[] storage arr = _deferredROIStreams[person];
        uint256 len = arr.length;
        lvl = type(uint8).max;
        for (uint256 i = 0; i < len; ) {
            StreamRef storage r = arr[i];
            if (r.investor == investor && r.lockIndex == lockIndex
                && r.level > minLevel && r.level < lvl)
            {
                lvl  = r.level;
                idx  = i;
                found = true;
            }
            unchecked { i++; }
        }
    }

    function _removeDeferredAt(address person, uint256 idx) internal {
        StreamRef[] storage arr = _deferredROIStreams[person];
        arr[idx] = arr[arr.length - 1];
        arr.pop();
    }

    // ── Core assignment (Option B) ────────────────────────────────────────────
    //
    // Assigns the stream at `level` for (investor, lockIndex) by walking from
    // the investor's DIRECT referrer every time, ensuring the closest eligible
    // free person always gets the highest-rate level.
    //
    // Precondition: stream.recipient == address(0) and stream.ended == false.
    //
    // Walk rules for each person P encountered:
    //   • Ineligible (activeReferralCount[P] <= level, P != owner):
    //       → _skippedROIStreams[P][level] += ref; continue up.
    //   • Eligible, holds LOWER-level stream from this lock (busy with higher priority):
    //       → _deferredROIStreams[P] += ref; continue up.
    //         (P will cascade-take this level when their lower-level stream ends.)
    //   • Eligible, holds HIGHER-level stream from this lock (lower priority):
    //       → P takes incoming (better rate), drops held stream.
    //         Held stream cascades up recursively from P's referrer.
    //   • Eligible, holds nothing from this lock:
    //       → P takes the stream; done.
    //   • Owner reached:
    //       → Owner takes it (Owner is exempt from one-stream-per-lock rule); done.
    //   • Chain exhausted with no one:
    //       → Nobody accumulates (stream.recipient stays address(0)).
    function _assignStream(address investor, uint64 lockIndex, uint8 level) internal {
        ROIStream storage stream = _roiStreams[investor][lockIndex][level];
        if (stream.ended) return;

        StreamRef memory ref = StreamRef({ investor: investor, lockIndex: lockIndex, level: level });
        address current = users[investor].referrer;
        uint256 hops    = 0;

        while (current != address(0) && users[current].isRegistered && hops < MAX_ROI_HOPS) {
            unchecked { hops++; }

            if (current == owner) {
                stream.recipient      = owner;
                stream.recipientSince = uint64(block.timestamp);
                _activeROIStreams[owner].push(ref);
                return;
            }

            if (activeReferralCount[current] <= level) {
                // Ineligible at this level
                _skippedROIStreams[current][level].push(ref);
                current = users[current].referrer;
                continue;
            }

            // Eligible — check if busy with a higher-priority (lower-level) stream
            if (_holdsLowerLevel(investor, lockIndex, level, current)) {
                // current must keep their lower-level stream; defer this one
                _deferredROIStreams[current].push(ref);
                current = users[current].referrer;
                continue;
            }

            // Eligible — check if holding a lower-priority (higher-level) stream
            uint8 heldLvl = _getHeldLevel(investor, lockIndex, current);
            if (heldLvl != type(uint8).max && heldLvl > level) {
                // Incoming has higher priority → current takes it, drops held
                stream.recipient      = current;
                stream.recipientSince = uint64(block.timestamp);
                _activeROIStreams[current].push(ref);

                // Settle and release the held stream
                ROIStream storage heldStream = _roiStreams[investor][lockIndex][heldLvl];
                _settleStream(heldStream, investor, lockIndex, heldLvl);
                _removeFromActive(current, investor, lockIndex, heldLvl);
                heldStream.recipient = address(0);

                // Re-assign the displaced level (starts from direct referrer again)
                _assignStream(investor, lockIndex, heldLvl);
                return;
            }

            // Eligible and free — assign directly
            stream.recipient      = current;
            stream.recipientSince = uint64(block.timestamp);
            _activeROIStreams[current].push(ref);
            return;
        }
        // Nobody found — stream.recipient remains address(0)
    }

    // Called after `person` is freed from a stream at `freedLevel` for this lock.
    // Finds the lowest deferred stream from the same lock at a level above freedLevel
    // and cascades: person takes it, the displaced holder cascades their own deferreds.
    function _cascadeDeferred(
        address person, address investor, uint64 lockIndex, uint8 freedLevel
    ) internal {
        if (person == owner) return;

        (bool found, uint8 dLvl, uint256 dIdx) = _findLowestDeferred(person, investor, lockIndex, freedLevel);
        if (!found) return;

        _removeDeferredAt(person, dIdx);

        ROIStream storage stream = _roiStreams[investor][lockIndex][dLvl];
        if (stream.ended) return;
        if (stream.recipient == person) return; // duplicate deferred entry

        // Validate eligibility (person might have lost it since deferral)
        if (activeReferralCount[person] <= dLvl) {
            _skippedROIStreams[person][dLvl].push(
                StreamRef({ investor: investor, lockIndex: lockIndex, level: dLvl })
            );
            return;
        }

        // Person takes over the stream from its current holder
        address displaced = stream.recipient;
        _settleStream(stream, investor, lockIndex, dLvl);
        if (displaced != address(0)) {
            _removeFromActive(displaced, investor, lockIndex, dLvl);
        }
        stream.recipient      = person;
        stream.recipientSince = uint64(block.timestamp);
        _activeROIStreams[person].push(StreamRef({ investor: investor, lockIndex: lockIndex, level: dLvl }));

        // Cascade: displaced holder is freed from dLvl
        if (displaced != address(0) && displaced != owner) {
            _cascadeDeferred(displaced, investor, lockIndex, dLvl);
        }
    }

    // ── External (DELEGATECALL) mutators ──────────────────────────────────────

    // Called by invest() after the LP lock is pushed.
    function initROIStreamsExt(address investor, uint256 lockIndex) external payable {
        LPLock storage lock = userLPLocks[investor][lockIndex];
        uint256 capBase = lock.ethInvested;

        for (uint8 i = 0; i < 10; ) {
            ROIStream storage stream = _roiStreams[investor][lockIndex][i];
            stream.ended          = false;
            stream.roiPaidETH     = 0;
            stream.capETH         = uint128(capBase * referralCommissionRates[i] / 10_000);
            stream.recipientSince = uint64(block.timestamp);
            stream.recipient      = address(0);

            _assignStream(investor, uint64(lockIndex), i);
            unchecked { i++; }
        }
    }

    // Called by _removeLPCore() before onLossReferralExt.
    function endROIStreamsExt(address investor, uint256 lockIndex) external payable {
        for (uint8 i = 0; i < 10; ) {
            ROIStream storage stream = _roiStreams[investor][lockIndex][i];
            if (!stream.ended) {
                _settleStream(stream, investor, lockIndex, i);
                if (stream.recipient != address(0)) {
                    _removeFromActive(stream.recipient, investor, uint64(lockIndex), i);
                }
                stream.ended     = true;
                stream.recipient = address(0);
            }
            unchecked { i++; }
        }
        // _deferredROIStreams / _skippedROIStreams entries for this lock are lazily
        // invalidated: _cascadeDeferred and onGainReferralExt check stream.ended.
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
            if (stream.recipient == referrer) continue; // duplicate skip entry

            // Referrer is now eligible — check if busy with lower-level from same lock
            if (_holdsLowerLevel(ref.investor, ref.lockIndex, newLevel, referrer)) {
                _deferredROIStreams[referrer].push(ref);
                continue;
            }

            // Referrer is eligible and free — redirect stream to referrer
            address oldHolder = stream.recipient;
            _settleStream(stream, ref.investor, ref.lockIndex, ref.level);
            if (oldHolder != address(0)) {
                _removeFromActive(oldHolder, ref.investor, ref.lockIndex, ref.level);
            }
            stream.recipient      = referrer;
            stream.recipientSince = uint64(block.timestamp);
            _activeROIStreams[referrer].push(ref);

            // Old holder is freed — cascade their deferred queue
            if (oldHolder != address(0) && oldHolder != owner) {
                _cascadeDeferred(oldHolder, ref.investor, ref.lockIndex, ref.level);
            }
        }
        delete _skippedROIStreams[referrer][newLevel];
    }

    // Called after activeReferralCount[referrer] has been decremented.
    function onLossReferralExt(address referrer) external payable {
        uint8 lostLevel = uint8(activeReferralCount[referrer]); // new lower count = lost level (0-indexed)

        StreamRef[] storage active = _activeROIStreams[referrer];
        uint256 i = 0;
        while (i < active.length) {
            StreamRef memory ref = active[i];
            ROIStream storage stream = _roiStreams[ref.investor][ref.lockIndex][ref.level];

            if (stream.ended || ref.level != lostLevel) {
                unchecked { i++; }
                continue;
            }

            // Settle referrer's accrual and release stream
            _settleStream(stream, ref.investor, ref.lockIndex, ref.level);
            _removeFromActive(referrer, ref.investor, ref.lockIndex, ref.level);
            stream.recipient = address(0);

            // Re-assign from investor's direct referrer (Option B).
            // _assignStream will encounter referrer (now ineligible) and add to
            // _skippedROIStreams[referrer][lostLevel] so they can reclaim on re-eligibility.
            _assignStream(ref.investor, ref.lockIndex, ref.level);
            // Do NOT increment i — _removeFromActive did a swap-and-pop.
        }
    }

    // Settle all active streams for recipient into _roiPendingETH.
    // Called by claimAllROI() before reading _roiPendingETH.
    function settleAllStreamsExt(address recipient) external payable {
        StreamRef[] storage arr = _activeROIStreams[recipient];
        uint256 len = arr.length;
        for (uint256 i = 0; i < len; ) {
            StreamRef storage ref = arr[i];
            ROIStream storage stream = _roiStreams[ref.investor][ref.lockIndex][ref.level];
            if (!stream.ended) _settleStream(stream, ref.investor, ref.lockIndex, ref.level);
            unchecked { i++; }
        }
    }

    // Settle a single stream for msg.sender (called by claimROIFromStream).
    function settleStreamExt(address investor, uint256 lockIndex, uint8 level) external payable {
        ROIStream storage stream = _roiStreams[investor][lockIndex][level];
        if (!stream.ended && stream.recipient == msg.sender) {
            _settleStream(stream, investor, lockIndex, level);
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
        return _calcAccrued(_roiStreams[investor][lockIndex][level], investor, lockIndex, level);
    }
}
