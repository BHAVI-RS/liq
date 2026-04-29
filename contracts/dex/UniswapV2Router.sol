// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// ── Minimal interfaces ──────────────────────────

interface IFactory {
    function getPair(address tokenA, address tokenB) external view returns (address);
    function createPair(address tokenA, address tokenB) external returns (address);
}

interface IPair {
    function getReserves() external view returns (uint112 r0, uint112 r1, uint32 ts);
    function token0()      external view returns (address);
    function mint(address to) external returns (uint256 liquidity);
    function burn(address to) external returns (uint256 amount0, uint256 amount1);
    function swap(uint256 out0, uint256 out1, address to, bytes calldata data) external;
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

interface IERC20 {
    function approve(address spender, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

interface IWETH {
    function deposit()  external payable;
    function withdraw(uint256 wad) external;
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

// ───────────────────────────────────────────────
/// @title UniswapV2Router
/// @notice High-level router.  Users interact with this contract only.
///
///  Key concepts:
///   • Slippage protection via amountMin / amountMax parameters
///   • deadline modifier — tx reverts if mined too late
///   • WETH wrapping / unwrapping is handled transparently for ETH pairs
///   • Multi-hop swaps supported (path length ≥ 2)
// ───────────────────────────────────────────────
contract UniswapV2Router {

    address public immutable factory;
    address public immutable WETH;

    modifier ensure(uint256 deadline) {
        require(deadline >= block.timestamp, "UniswapV2Router: EXPIRED");
        _;
    }

    constructor(address _factory, address _WETH) {
        factory = _factory;
        WETH    = _WETH;
    }

    /// @dev Accept ETH only from WETH contract (during withdraw)
    receive() external payable {
        assert(msg.sender == WETH);
    }

    // ─────────────────────────────────────────────
    //  Pure / view helpers  (also useful on frontend)
    // ─────────────────────────────────────────────

    /// @notice Given equal-value amounts at current price, quote the other token amount.
    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB)
        public pure returns (uint256 amountB)
    {
        require(amountA > 0,                   "UniswapV2: INSUFFICIENT_AMOUNT");
        require(reserveA > 0 && reserveB > 0,  "UniswapV2: INSUFFICIENT_LIQUIDITY");
        amountB = amountA * reserveB / reserveA;
    }

    /// @notice Exact-input amount → output amount  (0.3 % fee applied to input).
    ///         Use for "how many tokens do I get for X ETH?"
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        public pure returns (uint256 amountOut)
    {
        require(amountIn > 0,                       "UniswapV2: INSUFFICIENT_INPUT_AMOUNT");
        require(reserveIn > 0 && reserveOut > 0,    "UniswapV2: INSUFFICIENT_LIQUIDITY");
        // fee deducted: effectiveIn = amountIn * 997 / 1000
        // amountOut = effectiveIn * reserveOut / (reserveIn + effectiveIn)
        uint256 inWithFee = amountIn * 997;
        amountOut = (inWithFee * reserveOut) / (reserveIn * 1000 + inWithFee);
    }

    /// @notice Exact-output amount → required input amount  (0.3 % fee applied to input).
    ///         Use for "how much ETH do I need to get exactly X tokens?"
    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut)
        public pure returns (uint256 amountIn)
    {
        require(amountOut > 0,                      "UniswapV2: INSUFFICIENT_OUTPUT_AMOUNT");
        require(reserveIn > 0 && reserveOut > 0,    "UniswapV2: INSUFFICIENT_LIQUIDITY");
        amountIn = (reserveIn * amountOut * 1000) / ((reserveOut - amountOut) * 997) + 1;
    }

    /// @notice Calculate output amounts for every hop in a path (exact-input).
    function getAmountsOut(uint256 amountIn, address[] memory path)
        public view returns (uint256[] memory amounts)
    {
        require(path.length >= 2, "UniswapV2: INVALID_PATH");
        amounts    = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i; i < path.length - 1; i++) {
            (uint256 rIn, uint256 rOut) = _getReserves(path[i], path[i + 1]);
            amounts[i + 1] = getAmountOut(amounts[i], rIn, rOut);
        }
    }

    /// @notice Calculate required input amounts for every hop in a path (exact-output).
    function getAmountsIn(uint256 amountOut, address[] memory path)
        public view returns (uint256[] memory amounts)
    {
        require(path.length >= 2, "UniswapV2: INVALID_PATH");
        amounts = new uint256[](path.length);
        amounts[amounts.length - 1] = amountOut;
        for (uint256 i = path.length - 1; i > 0; i--) {
            (uint256 rIn, uint256 rOut) = _getReserves(path[i - 1], path[i]);
            amounts[i - 1] = getAmountIn(amounts[i], rIn, rOut);
        }
    }

    // ─────────────────────────────────────────────
    //  ADD LIQUIDITY
    // ─────────────────────────────────────────────

    /// @notice Add liquidity to a token/token pool.
    ///         Creates the pool if it doesn't exist yet.
    ///         Returns actual amounts deposited and LP tokens minted.
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,   // max tokens A willing to deposit
        uint256 amountBDesired,   // max tokens B willing to deposit
        uint256 amountAMin,       // slippage guard for A
        uint256 amountBMin,       // slippage guard for B
        address to,               // recipient of LP tokens
        uint256 deadline
    ) external ensure(deadline)
      returns (uint256 amountA, uint256 amountB, uint256 liquidity)
    {
        (amountA, amountB) = _optimalAmounts(tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin);
        address pair = _requirePair(tokenA, tokenB);
        IERC20(tokenA).transferFrom(msg.sender, pair, amountA);
        IERC20(tokenB).transferFrom(msg.sender, pair, amountB);
        liquidity = IPair(pair).mint(to);
    }

    /// @notice Add liquidity to a token/ETH pool (ETH is wrapped automatically).
    ///         Unused ETH is refunded.
    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable ensure(deadline)
      returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)
    {
        (amountToken, amountETH) = _optimalAmounts(
            token, WETH,
            amountTokenDesired, msg.value,
            amountTokenMin,     amountETHMin
        );
        address pair = _requirePair(token, WETH);
        IERC20(token).transferFrom(msg.sender, pair, amountToken);
        IWETH(WETH).deposit{value: amountETH}();
        IWETH(WETH).transfer(pair, amountETH);
        liquidity = IPair(pair).mint(to);

        // Refund unused ETH
        if (msg.value > amountETH) {
            (bool ok,) = msg.sender.call{value: msg.value - amountETH}("");
            require(ok, "UniswapV2Router: ETH_REFUND_FAILED");
        }
    }

    // ─────────────────────────────────────────────
    //  REMOVE LIQUIDITY
    // ─────────────────────────────────────────────

    /// @notice Burn LP tokens and receive back both underlying tokens.
    ///         amountAMin / amountBMin are slippage guards.
    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) public ensure(deadline)
      returns (uint256 amountA, uint256 amountB)
    {
        address pair = _requirePair(tokenA, tokenB);
        IPair(pair).transferFrom(msg.sender, pair, liquidity); // send LP tokens to pair
        (uint256 amt0, uint256 amt1) = IPair(pair).burn(to);

        (address t0,) = _sortTokens(tokenA, tokenB);
        (amountA, amountB) = tokenA == t0 ? (amt0, amt1) : (amt1, amt0);
        require(amountA >= amountAMin, "UniswapV2Router: INSUFFICIENT_A_AMOUNT");
        require(amountB >= amountBMin, "UniswapV2Router: INSUFFICIENT_B_AMOUNT");
    }

    /// @notice Burn LP tokens from a token/ETH pool and receive token + ETH.
    function removeLiquidityETH(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) public ensure(deadline)
      returns (uint256 amountToken, uint256 amountETH)
    {
        // Receive both assets at the router, then unwrap WETH
        (amountToken, amountETH) = removeLiquidity(
            token, WETH,
            liquidity,
            amountTokenMin, amountETHMin,
            address(this),
            deadline
        );
        IERC20(token).transfer(to, amountToken);
        IWETH(WETH).withdraw(amountETH);
        (bool ok,) = to.call{value: amountETH}("");
        require(ok, "UniswapV2Router: ETH_TRANSFER_FAILED");
    }

    /// @notice removeLiquidity with off-chain permit (no separate approve tx needed).
    function removeLiquidityWithPermit(
        address tokenA, address tokenB,
        uint256 liquidity,
        uint256 amountAMin, uint256 amountBMin,
        address to, uint256 deadline,
        bool approveMax, uint8 v, bytes32 r, bytes32 s
    ) external returns (uint256 amountA, uint256 amountB) {
        // Permit in a helper to stay under the stack limit
        _callPermit(_requirePair(tokenA, tokenB), approveMax ? type(uint256).max : liquidity, deadline, v, r, s);
        (amountA, amountB) = removeLiquidity(tokenA, tokenB, liquidity, amountAMin, amountBMin, to, deadline);
    }

    /// @notice removeLiquidityETH with off-chain permit.
    function removeLiquidityETHWithPermit(
        address token, uint256 liquidity,
        uint256 amountTokenMin, uint256 amountETHMin,
        address to, uint256 deadline,
        bool approveMax, uint8 v, bytes32 r, bytes32 s
    ) external returns (uint256 amountToken, uint256 amountETH) {
        _callPermit(_requirePair(token, WETH), approveMax ? type(uint256).max : liquidity, deadline, v, r, s);
        (amountToken, amountETH) = removeLiquidityETH(token, liquidity, amountTokenMin, amountETHMin, to, deadline);
    }

    /// @dev Call EIP-2612 permit on an LP token. Extracted to avoid "stack too deep" in callers.
    function _callPermit(address pair, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) private {
        (bool ok, ) = pair.call(abi.encodeWithSignature(
            "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
            msg.sender, address(this), value, deadline, v, r, s
        ));
        require(ok, "UniswapV2Router: PERMIT_FAILED");
    }

    // ─────────────────────────────────────────────
    //  SWAP
    // ─────────────────────────────────────────────

    /// @notice Swap exact tokens for tokens (minimum output enforces slippage).
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,  // slippage guard
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        amounts = getAmountsOut(amountIn, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT");
        IERC20(path[0]).transferFrom(msg.sender, _requirePair(path[0], path[1]), amounts[0]);
        _executeSwap(amounts, path, to);
    }

    /// @notice Swap tokens for exact tokens (maximum input enforces slippage).
    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,   // slippage guard
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        amounts = getAmountsIn(amountOut, path);
        require(amounts[0] <= amountInMax, "UniswapV2Router: EXCESSIVE_INPUT_AMOUNT");
        IERC20(path[0]).transferFrom(msg.sender, _requirePair(path[0], path[1]), amounts[0]);
        _executeSwap(amounts, path, to);
    }

    /// @notice Send exact ETH, receive minimum tokens.
    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable ensure(deadline) returns (uint256[] memory amounts) {
        require(path[0] == WETH, "UniswapV2Router: INVALID_PATH");
        amounts = getAmountsOut(msg.value, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT");
        IWETH(WETH).deposit{value: amounts[0]}();
        IWETH(WETH).transfer(_requirePair(path[0], path[1]), amounts[0]);
        _executeSwap(amounts, path, to);
    }

    /// @notice Send exact tokens, receive minimum ETH.
    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        require(path[path.length - 1] == WETH, "UniswapV2Router: INVALID_PATH");
        amounts = getAmountsOut(amountIn, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT");
        IERC20(path[0]).transferFrom(msg.sender, _requirePair(path[0], path[1]), amounts[0]);
        _executeSwap(amounts, path, address(this));
        IWETH(WETH).withdraw(amounts[amounts.length - 1]);
        (bool ok,) = to.call{value: amounts[amounts.length - 1]}("");
        require(ok, "UniswapV2Router: ETH_TRANSFER_FAILED");
    }

    /// @notice Send maximum tokens, receive exact ETH.
    function swapTokensForExactETH(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        require(path[path.length - 1] == WETH, "UniswapV2Router: INVALID_PATH");
        amounts = getAmountsIn(amountOut, path);
        require(amounts[0] <= amountInMax, "UniswapV2Router: EXCESSIVE_INPUT_AMOUNT");
        IERC20(path[0]).transferFrom(msg.sender, _requirePair(path[0], path[1]), amounts[0]);
        _executeSwap(amounts, path, address(this));
        IWETH(WETH).withdraw(amounts[amounts.length - 1]);
        (bool ok,) = to.call{value: amounts[amounts.length - 1]}("");
        require(ok, "UniswapV2Router: ETH_TRANSFER_FAILED");
    }

    /// @notice Send maximum ETH, receive exact tokens.  Unused ETH refunded.
    function swapETHForExactTokens(
        uint256 amountOut,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable ensure(deadline) returns (uint256[] memory amounts) {
        require(path[0] == WETH, "UniswapV2Router: INVALID_PATH");
        amounts = getAmountsIn(amountOut, path);
        require(amounts[0] <= msg.value, "UniswapV2Router: EXCESSIVE_INPUT_AMOUNT");
        IWETH(WETH).deposit{value: amounts[0]}();
        IWETH(WETH).transfer(_requirePair(path[0], path[1]), amounts[0]);
        _executeSwap(amounts, path, to);
        if (msg.value > amounts[0]) {
            (bool ok,) = msg.sender.call{value: msg.value - amounts[0]}("");
            require(ok, "UniswapV2Router: ETH_REFUND_FAILED");
        }
    }

    // ─────────────────────────────────────────────
    //  Internal helpers
    // ─────────────────────────────────────────────

    /// @dev Execute a multi-hop swap given pre-calculated amounts.
    function _executeSwap(uint256[] memory amounts, address[] memory path, address _to) internal {
        for (uint256 i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address t0,)   = _sortTokens(input, output);
            uint256 outAmt  = amounts[i + 1];
            (uint256 out0, uint256 out1) = input == t0 ? (uint256(0), outAmt) : (outAmt, uint256(0));
            // For intermediate hops, send directly to the next pair
            address recipient = i < path.length - 2 ? _requirePair(output, path[i + 2]) : _to;
            IPair(_requirePair(input, output)).swap(out0, out1, recipient, new bytes(0));
        }
    }

    /// @dev Calculate optimal token amounts for adding liquidity.
    ///      Creates the pair if it doesn't exist yet.
    function _optimalAmounts(
        address tokenA, address tokenB,
        uint256 desiredA, uint256 desiredB,
        uint256 minA,     uint256 minB
    ) internal returns (uint256 amountA, uint256 amountB) {
        if (IFactory(factory).getPair(tokenA, tokenB) == address(0)) {
            IFactory(factory).createPair(tokenA, tokenB);
        }
        (uint256 rA, uint256 rB) = _getReserves(tokenA, tokenB);

        if (rA == 0 && rB == 0) {
            // Empty pool — use desired amounts as-is (sets the initial price)
            (amountA, amountB) = (desiredA, desiredB);
        } else {
            // Try to match desiredA exactly
            uint256 optB = quote(desiredA, rA, rB);
            if (optB <= desiredB) {
                require(optB >= minB, "UniswapV2Router: INSUFFICIENT_B_AMOUNT");
                (amountA, amountB) = (desiredA, optB);
            } else {
                // desiredA is too much — scale down to desiredB
                uint256 optA = quote(desiredB, rB, rA);
                require(optA <= desiredA && optA >= minA, "UniswapV2Router: INSUFFICIENT_A_AMOUNT");
                (amountA, amountB) = (optA, desiredB);
            }
        }
    }

    /// @dev Get reserves for a pair in the order (tokenA, tokenB).
    function _getReserves(address tokenA, address tokenB)
        internal view returns (uint256 rA, uint256 rB)
    {
        (address t0,)     = _sortTokens(tokenA, tokenB);
        address pair      = IFactory(factory).getPair(tokenA, tokenB);
        if (pair == address(0)) return (0, 0);
        (uint112 r0, uint112 r1,) = IPair(pair).getReserves();
        (rA, rB) = tokenA == t0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    /// @dev Sort two token addresses (token0 < token1).
    function _sortTokens(address tA, address tB) internal pure returns (address t0, address t1) {
        (t0, t1) = tA < tB ? (tA, tB) : (tB, tA);
    }

    /// @dev Return pair address, reverting if it doesn't exist.
    function _requirePair(address tA, address tB) internal view returns (address pair) {
        pair = IFactory(factory).getPair(tA, tB);
        require(pair != address(0), "UniswapV2Router: PAIR_NOT_FOUND");
    }
}
