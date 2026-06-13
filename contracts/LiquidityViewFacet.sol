// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./LiquidityStorage.sol";
import "./LiquidityMath.sol";
import "./LiquidityViewLib.sol";

interface IERC20V {
    function balanceOf(address account) external view returns (uint256);
}

// Read-only DELEGATECALL facet. Liquidity.sol forwards every unknown selector here through
// its fallback(), so these functions execute in Liquidity.sol's storage context via eth_call.
//
// Two jobs:
//   1. Hold all the heavy ABI-encoding view getters that used to live in Liquidity.sol —
//      moving them here keeps the core Liquidity contract under the 24 KB mainnet limit.
//   2. Provide batch/aggregation views (getDownline, *Batch) that traverse the referral tree
//      and read many users' state in a SINGLE on-chain pass, so the frontend replaces its
//      per-user RPC loops (one call per member) with one round trip.
//
// Immutables are baked into this facet's own bytecode at deploy time (same addresses passed
// to LiquidityFacet) and are read correctly under delegatecall.
contract LiquidityViewFacet is LiquidityStorage {

    address private immutable UNISWAP_FACTORY;
    address private immutable WETH;
    address public  immutable platformToken;

    uint256 private constant LP_LOCK_DURATION = 180; // 90 days scaled: 1 day = 2 s (testing)
    uint256 private constant USDT_PER_ETH     = 1;

    constructor(address _factory, address _weth, address _platform) {
        UNISWAP_FACTORY = _factory;
        WETH            = _weth;
        platformToken   = _platform;
    }

    // ── Simple getters (moved verbatim from Liquidity.sol) ─────────────────────
    function getActiveDirectReferralCount(address _user) external view returns (uint256) {
        return activeReferralCount[_user];
    }
    function getPlatformStats() external view returns (
        uint256 _totalUsers, uint256 _totalEthInvested, uint256 _totalStakingRewardsPaidETH
    ) {
        return (totalRegisteredUsers + 1, totalEthInvested, totalStakingRewardsPaidETH);
    }
    function getAllRegisteredUsers() external view returns (address[] memory) {
        return allRegisteredUsers;
    }
    function getUserLPLocks(address _user) external view returns (LPLock[] memory) {
        return userLPLocks[_user];
    }
    function getRegisteredTokens() external view returns (address[] memory) {
        return registeredTokens;
    }
    function getToken(address _tokenAddress) external view returns (Token memory) {
        return tokens[_tokenAddress];
    }
    function getReferrals(address _user) external view returns (address[] memory) {
        return users[_user].referrals;
    }
    function getReferrer(address _user) external view returns (address) {
        return users[_user].referrer;
    }
    function getContractTokenBalance(address _token) external view returns (uint256) {
        return IERC20V(_token).balanceOf(address(this));
    }
    function getStakingReward(address _user) external view returns (
        uint256 totalAccumulated, uint256 previewNewTokens, uint256 lifetimeClaimed
    ) {
        uint256 price = LiquidityMath.tokenPriceInETH(UNISWAP_FACTORY, platformToken, WETH);
        return LiquidityViewLib.computeStakingReward(userLPLocks[_user], price);
    }
    function getUserCommissionStats(address _user) external view returns (
        uint256 earned, uint256, uint256 totalCap, uint256 remainingCap, uint256 active
    ) {
        return LiquidityViewLib.computeCommissionStats(
            userLPLocks[_user], userCommissionsEarned[_user], userTotalInvested[_user], block.timestamp
        );
    }
    function getDirectRefsInfo(address user) external view returns (DirectRefInfo[] memory result) {
        address[] memory refs = users[user].referrals;
        uint256 len = refs.length;
        result = new DirectRefInfo[](len);
        for (uint256 i = 0; i < len; ) {
            address ref = refs[i];
            result[i].addr           = ref;
            result[i].totalInvested  = userTotalInvested[ref];
            result[i].directRefCount = users[ref].referrals.length;
            (,, uint256 tc, uint256 rc,) = LiquidityViewLib.computeCommissionStats(
                userLPLocks[ref], userCommissionsEarned[ref], userTotalInvested[ref], block.timestamp
            );
            result[i].remainingCap = rc;
            result[i].totalCap     = tc;
            unchecked { i++; }
        }
    }
    function getWealthParams(address _user) public view returns (WealthParams memory) {
        return LiquidityViewLib.computeWealthParams(
            userLPLocks[_user], userCommissionsEarned[_user],
            LiquidityMath.tokenPriceInETH(UNISWAP_FACTORY, platformToken, WETH),
            LP_LOCK_DURATION, UNISWAP_FACTORY, WETH
        );
    }
    function getStakingRatesForAmount(uint256 ethInvestedWei) external view returns (
        uint256[6] memory durSecs, uint256[6] memory ratesPPM
    ) {
        uint256 investUSDT = ethInvestedWei * USDT_PER_ETH / 1e18;
        bool hasReward = investUSDT >= 100;
        uint256 tierIdx = hasReward ? LiquidityMath.getTierIndex(investmentTiers, ethInvestedWei) : 0;
        for (uint256 i = 0; i < 6; ) {
            durSecs[i]  = stakingDurations[i];
            ratesPPM[i] = hasReward ? stakingRates[i][tierIdx][0] : 0;
            unchecked { i++; }
        }
    }
    function setRefLabel(address _ref, bytes calldata _label) external {
        _refLabels[msg.sender][_ref] = _label;
    }
    function getRefLabel(address _owner, address _ref) external view returns (bytes memory) {
        return _refLabels[_owner][_ref];
    }
    function getPriceHistory(address _token) external view returns (PriceSnap[] memory) {
        return _priceHistory[_token];
    }
    function getTradeHistory(address _token) external view returns (TradeSnap[] memory) {
        return _tradeHistory[_token];
    }
    function getCommissionRecords(address _user) external view returns (CommissionRecord[] memory) {
        return _commissionRecords[_user];
    }
    function getMissedRecords(address _user) external view returns (MissedRecord[] memory) {
        return _missedRecords[_user];
    }
    function getInvestRecords(address _user) external view returns (InvestRecord[] memory) {
        return _investRecords[_user];
    }
    function getClaimRecords(address _user) external view returns (ClaimRecord[] memory) {
        return _claimRecords[_user];
    }
    function getROIClaimRecords(address _user) external view returns (ClaimRecord[] memory) {
        return _roiClaimRecords[_user];
    }
    function getLPEventRecords(address _user) external view returns (LPEventRecord[] memory) {
        return _lpEventRecords[_user];
    }
    function getCapPausedAt(address user) external view returns (uint64) {
        return _capPausedAt[user];
    }

    // Authoritative live available cap (active locks only) = raw active cap − pending ROI − live
    // ROI accrual.  Mirrors the exact value the contract gates accrual against (_getAvailableCap).
    // The UI should use THIS instead of reconstructing cap from getROIData, whose liveETH collapses
    // to 0 at exhaustion and makes reconstructed cap over-report remaining headroom.
    function getAvailableCap(address user) external view returns (uint256) {
        return _getAvailableCap(user);
    }

    // Same, but the raw base also counts expired (non-removed) locks — the settlement-inclusive
    // available cap used by the Investments tab (which shows cap on expired/not-staked locks too).
    function getAvailableCapInclExpired(address user) external view returns (uint256) {
        return _getAvailableCapInclExpired(user);
    }

    // ── ROI view functions (read directly from inherited storage) ─────────────
    function getROIPending(address recipient) external view returns (uint256 total) {
        total = _roiPendingETH[recipient];
        StreamRef[] storage arr = _activeROIStreams[recipient];
        for (uint256 i = 0; i < arr.length; ) {
            StreamRef storage ref = arr[i];
            ROIStream storage stream = _roiStreams[ref.investor][ref.lockIndex][ref.level];
            if (!stream.ended) total += _calcAccrued(stream, ref.investor, ref.lockIndex, ref.level);
            unchecked { i++; }
        }
    }
    function getROIData(address recipient) public view returns (uint256 liveETH, uint256 pendingETH) {
        pendingETH = _roiPendingETH[recipient];
        if (_capPausedAt[recipient] > 0) return (0, pendingETH);
        if (_getRawAvailableCapInclExpired(recipient) == 0) return (0, pendingETH);
        if (_getAvailableCap(recipient) == 0) return (0, pendingETH);
        StreamRef[] storage arr = _activeROIStreams[recipient];
        for (uint256 i = 0; i < arr.length; ) {
            StreamRef storage ref = arr[i];
            ROIStream storage stream = _roiStreams[ref.investor][ref.lockIndex][ref.level];
            if (!stream.ended) liveETH += _calcAccruedRaw(stream, ref.investor, ref.lockIndex, ref.level);
            unchecked { i++; }
        }
    }
    function getActiveROIStreams(address recipient) external view returns (StreamRef[] memory) {
        return _activeROIStreams[recipient];
    }
    function getROIStreamInfo(address investor, uint256 lockIndex, uint8 level)
        external view returns (ROIStream memory)
    {
        return _roiStreams[investor][lockIndex][level];
    }
    function getROIAccrued(address investor, uint256 lockIndex, uint8 level)
        external view returns (uint256)
    {
        ROIStream storage stream = _roiStreams[investor][lockIndex][level];
        return _calcAccrued(stream, investor, lockIndex, level);
    }

    // ── Batch / aggregation views ─────────────────────────────────────────────
    // Single-call alternatives to the frontend's per-member RPC loops.

    // Flattened downline tree under `root` (root included at index 0), depth-first.
    // Replaces fetchGeneTree()'s one-getReferrals()-per-node recursion AND the matching
    // userTotalInvested() loop with one on-chain traversal. maxDepth caps levels below root
    // (the genealogy view uses 10).
    function getDownline(address root, uint256 maxDepth) external view returns (DownlineNode[] memory out) {
        uint256 n = _countDownline(root, 0, maxDepth);
        out = new DownlineNode[](n);
        _fillDownline(root, 0, 0, maxDepth, out, 0);
    }

    function _countDownline(address a, uint256 depth, uint256 maxDepth) internal view returns (uint256 c) {
        c = 1;
        if (depth < maxDepth) {
            address[] storage kids = users[a].referrals;
            uint256 kl = kids.length;
            for (uint256 i = 0; i < kl; ) {
                c += _countDownline(kids[i], depth + 1, maxDepth);
                unchecked { i++; }
            }
        }
    }

    function _fillDownline(
        address a, uint32 parent, uint32 depth, uint256 maxDepth,
        DownlineNode[] memory out, uint256 idx
    ) internal view returns (uint256) {
        uint32 myIdx = uint32(idx);
        out[idx] = DownlineNode({
            addr:          a,
            parent:        parent,
            depth:         depth,
            totalInvested: userTotalInvested[a]
        });
        unchecked { idx++; }
        if (depth < maxDepth) {
            address[] storage kids = users[a].referrals;
            uint256 kl = kids.length;
            for (uint256 i = 0; i < kl; ) {
                idx = _fillDownline(kids[i], myIdx, depth + 1, maxDepth, out, idx);
                unchecked { i++; }
            }
        }
        return idx;
    }

    // WealthParams for many users in one call (dashboard/team wealth, ref popup).
    function getWealthParamsBatch(address[] calldata usersArr)
        external view returns (WealthParams[] memory out)
    {
        uint256 len = usersArr.length;
        out = new WealthParams[](len);
        for (uint256 i = 0; i < len; ) {
            out[i] = getWealthParams(usersArr[i]);
            unchecked { i++; }
        }
    }

    // Live + pending ROI for many users in one call (team wealth ROI component).
    function getROIDataBatch(address[] calldata usersArr)
        external view returns (uint256[] memory liveETH, uint256[] memory pendingETH)
    {
        uint256 len = usersArr.length;
        liveETH    = new uint256[](len);
        pendingETH = new uint256[](len);
        for (uint256 i = 0; i < len; ) {
            (liveETH[i], pendingETH[i]) = getROIData(usersArr[i]);
            unchecked { i++; }
        }
    }

    // LP locks for many users in one call (ROI per-second rate computation).
    function getUserLPLocksBatch(address[] calldata usersArr)
        external view returns (LPLock[][] memory out)
    {
        uint256 len = usersArr.length;
        out = new LPLock[][](len);
        for (uint256 i = 0; i < len; ) {
            out[i] = userLPLocks[usersArr[i]];
            unchecked { i++; }
        }
    }
}
