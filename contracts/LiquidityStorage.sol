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

    // Helper shared by Liquidity.sol and facets
    function _qualifies(address _user) internal view returns (bool) {
        uint256 total = userTotalInvested[_user];
        return total > 0 && (minDirectReferralInvestment == 0 || total >= minDirectReferralInvestment);
    }

    // ROI accrual constants and helper — shared with Liquidity.sol view functions so that
    // getROIAccrued/getROIPending can read directly from inherited storage instead of calling
    // the ROI facet as a regular CALL (which would read the facet's own empty storage).
    uint256 internal constant _ROI_DENOM         = 50_000_000_000;
    uint256 internal constant _ROI_LOCK_DURATION = 90 days;

    function _calcAccrued(
        ROIStream storage stream,
        address investor,
        uint256 lockIndex,
        uint8   level
    ) internal view returns (uint256 accrued) {
        if (stream.ended || stream.recipient == address(0)) return 0;
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
        uint256 rate    = referralCommissionRates[level];
        accrued = lock.ethInvested * lock.rewardRatePPM * elapsed * rate / (_ROI_DENOM * lockDur);
        uint256 capLeft = stream.capETH > stream.roiPaidETH ? stream.capETH - stream.roiPaidETH : 0;
        if (accrued > capLeft) accrued = capLeft;
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
}
