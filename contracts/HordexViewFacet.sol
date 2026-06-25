// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./HordexStorage.sol";
import "./HordexMath.sol";
import "./HordexViewLib.sol";

/**
 * @title  HordexViewFacet — On-Chain Analytics
 * @notice Read-only analytics and aggregation layer for the Hordex platform. https://hordex.club
 *
 * @dev This module gives the Hordex interface a fast, comprehensive, fully on-chain view of
 *      the platform. It exposes detailed getters for positions, rewards, pricing, and history,
 *      plus efficient batch and team-tree aggregations that gather many participants' data in a
 *      single call. The result is a responsive experience backed entirely by verifiable chain
 *      state — no off-chain indexers required.
 */
interface IERC20V {
    function balanceOf(address account) external view returns (uint256);
}

contract HordexViewFacet is HordexStorage {

    address private immutable UNISWAP_FACTORY;
    address private immutable WETH;
    address public  immutable platformToken;

    uint256 private constant SWAP_SLIPPAGE_BPS = 200;

    constructor(address _factory, address _weth, address _platform) {
        UNISWAP_FACTORY = _factory;
        WETH            = _weth;
        platformToken   = _platform;
    }

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

    function quoteSwapBuy(address _token, uint256 _usdtIn) external view returns (
        uint256 tokensOut, uint256 usdtSpent, uint256 poolUsdt, uint256 invTokensOut
    ) {
        if (_usdtIn == 0) return (0, 0, 0, 0);
        address pair = IUniV2FactoryMin(UNISWAP_FACTORY).getPair(_token, WETH);
        if (pair == address(0)) return (0, 0, 0, 0);
        (uint112 r0, uint112 r1,) = IUniV2PairMin(pair).getReserves();
        address t0     = IUniV2PairMin(pair).token0();
        uint256 resTok = t0 == _token ? uint256(r0) : uint256(r1);
        uint256 resETH = t0 == _token ? uint256(r1) : uint256(r0);
        if (resTok == 0 || resETH == 0) return (0, 0, 0, 0);
        uint256 invBal = IERC20V(_token).balanceOf(address(this));
        uint256 poolTokensOut;
        (poolUsdt, poolTokensOut, invTokensOut, usdtSpent) =
            HordexMath.calcHybridBuy(resTok, resETH, _usdtIn, invBal, SWAP_SLIPPAGE_BPS);
        tokensOut = poolTokensOut + invTokensOut;
    }
    function getStakingReward(address _user) external view returns (
        uint256 totalAccumulated, uint256 previewNewTokens, uint256 lifetimeClaimed
    ) {
        uint256 price = HordexMath.tokenPriceInETH(UNISWAP_FACTORY, platformToken, WETH);
        return HordexViewLib.computeStakingReward(userLPLocks[_user], price);
    }
    function getUserCommissionStats(address _user) external view returns (
        uint256 earned, uint256, uint256 totalCap, uint256 remainingCap, uint256 active
    ) {
        return HordexViewLib.computeCommissionStats(
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
            (,, uint256 tc, uint256 rc,) = HordexViewLib.computeCommissionStats(
                userLPLocks[ref], userCommissionsEarned[ref], userTotalInvested[ref], block.timestamp
            );
            result[i].remainingCap = rc;
            result[i].totalCap     = tc;
            unchecked { i++; }
        }
    }
    function getWealthParams(address _user) public view returns (WealthParams memory) {
        return HordexViewLib.computeWealthParams(
            userLPLocks[_user], userCommissionsEarned[_user],
            HordexMath.tokenPriceInETH(UNISWAP_FACTORY, platformToken, WETH),
            LP_LOCK_DURATION, UNISWAP_FACTORY, WETH
        );
    }
    function getStakingRatesForAmount(uint256 ethInvestedWei) external view returns (
        uint256[6] memory durSecs, uint256[6] memory ratesPPM
    ) {
        uint256 investUSDT = ethInvestedWei / USDT_ONE;
        bool hasReward = investUSDT >= 100;
        uint256 tierIdx = hasReward ? HordexMath.getTierIndex(investmentTiers, ethInvestedWei) : 0;
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

    function getReserveStats(address _user) external view returns (uint256 total, uint256 claimable) {
        total     = _reserveTotalWei[_user];
        claimable = _reserveClaimableWei(_user);
    }

    function getReserveTranches(address _user) external view returns (ReserveTranche[] memory) {
        return _reserveTranches[_user];
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

    function getLockPeriods(address _user, uint256 _lockIndex) external view returns (LockPeriod[] memory) {
        return _lockPeriods[_user][_lockIndex];
    }
    function getCapPausedAt(address user) external view returns (uint64) {
        return _capPausedAt[user];
    }

    function getAvailableCap(address user) external view returns (uint256) {
        return _getAvailableCap(user);
    }

    function getAvailableCapInclExpired(address user) external view returns (uint256) {
        return _getAvailableCapInclExpired(user);
    }

    function getROIPending(address recipient) external view returns (uint256 total) {
        total = _roiPendingETH[recipient];
        uint64 retAt = _roiRetainedAt[recipient];
        StreamRef[] storage arr = _activeROIStreams[recipient];
        uint256 acc = 0;
        for (uint256 i = 0; i < arr.length; ) {
            StreamRef storage ref = arr[i];
            ROIStream storage stream = _roiStreams[ref.investor][ref.lockIndex][ref.level];
            if (!stream.ended) {

                acc += retAt != 0
                    ? _calcAccruedRawAt(stream, ref.investor, ref.lockIndex, ref.level, retAt)
                    : _calcAccrued(stream, ref.investor, ref.lockIndex, ref.level);
            }
            unchecked { i++; }
        }
        if (retAt != 0 && acc > _roiRetainedCap[recipient]) acc = _roiRetainedCap[recipient];
        total += acc;
    }
    function getROIData(address recipient) public view returns (uint256 liveETH, uint256 pendingETH) {
        pendingETH = _roiPendingETH[recipient];
        uint64 retAt = _roiRetainedAt[recipient];
        if (retAt != 0) {

            StreamRef[] storage rArr = _activeROIStreams[recipient];
            for (uint256 i = 0; i < rArr.length; ) {
                StreamRef storage ref = rArr[i];
                ROIStream storage s = _roiStreams[ref.investor][ref.lockIndex][ref.level];
                if (!s.ended) liveETH += _calcAccruedRawAt(s, ref.investor, ref.lockIndex, ref.level, retAt);
                unchecked { i++; }
            }
            if (liveETH > _roiRetainedCap[recipient]) liveETH = _roiRetainedCap[recipient];
            return (liveETH, pendingETH);
        }
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

    function getEligibilityGates()
        external view returns (uint32[10] memory selfGates, uint32[10] memory bizGates)
    {
        return (selfStakeGate, businessGate);
    }

    function getUserEligibility(address user)
        external view returns (uint256 selfStakeUSDT, uint256 teamBusinessUSDT, uint8 unlockedLevels)
    {
        selfStakeUSDT    = _activeSelfStakeUSDT(user);
        teamBusinessUSDT = _teamBusinessUSDT[user];
        for (uint8 i = 0; i < 10; ) {
            if (!_eligibleForLevel(user, i)) break;
            unlockedLevels++;
            unchecked { i++; }
        }
    }

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
