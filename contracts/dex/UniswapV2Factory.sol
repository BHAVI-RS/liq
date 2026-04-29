// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./UniswapV2Pair.sol";

/// @title UniswapV2Factory
/// @notice Deploys new pairs and keeps a registry.
///         Optionally routes a share of every swap fee to `feeTo`.
contract UniswapV2Factory {

    address public feeTo;       // receives protocol fee (if set)
    address public feeToSetter; // can change feeTo

    // token0 → token1 → pair  (token0 < token1 always)
    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    event PairCreated(address indexed token0, address indexed token1, address pair, uint256 totalPairs);

    constructor(address _feeToSetter) {
        feeToSetter = _feeToSetter;
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    /// @notice Deploy a new pair for tokenA/tokenB.
    ///         Tokens are sorted so token0 < token1 (deterministic pair address via CREATE2).
    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB,                              "UniswapV2: IDENTICAL_ADDRESSES");
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(t0 != address(0),                             "UniswapV2: ZERO_ADDRESS");
        require(getPair[t0][t1] == address(0),                "UniswapV2: PAIR_EXISTS");

        // Deploy with CREATE2 for deterministic address
        bytes32 salt = keccak256(abi.encodePacked(t0, t1));
        UniswapV2Pair newPair = new UniswapV2Pair{salt: salt}();
        newPair.initialize(t0, t1);

        pair             = address(newPair);
        getPair[t0][t1]  = pair;
        getPair[t1][t0]  = pair; // reverse mapping
        allPairs.push(pair);

        emit PairCreated(t0, t1, pair, allPairs.length);
    }

    // ── Fee management ──

    /// @notice Enable protocol fee: 1/6 of every 0.3 % swap fee is minted as LP tokens and sent here.
    function setFeeTo(address _feeTo) external {
        require(msg.sender == feeToSetter, "UniswapV2: FORBIDDEN");
        feeTo = _feeTo;
    }

    function setFeeToSetter(address _feeToSetter) external {
        require(msg.sender == feeToSetter, "UniswapV2: FORBIDDEN");
        feeToSetter = _feeToSetter;
    }
}
