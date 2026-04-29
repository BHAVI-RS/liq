// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./UniswapV2ERC20.sol";

// Minimal interface — only the feeTo getter is needed from the factory
interface IFactory {
    function feeTo() external view returns (address);
}

// Flash-swap callback — contracts that receive tokens via swap can implement this
interface IUniswapV2Callee {
    function uniswapV2Call(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external;
}

/// @title UniswapV2Pair
/// @notice Core AMM pool.  Implements:
///   - Constant-product AMM  (x * y = k)
///   - 0.3 % swap fee        (all to liquidity providers)
///   - Protocol fee          (1/6 of swap fee → feeTo, if enabled)
///   - LP tokens             (inherited from UniswapV2ERC20)
///   - TWAP price oracle     (price0/1CumulativeLast)
///   - Flash swaps           (swap() with non-empty data)
contract UniswapV2Pair is UniswapV2ERC20 {

    // ── Constants ──
    uint256 public constant MINIMUM_LIQUIDITY = 1000; // burned on first mint to prevent price manipulation

    // ── Immutable-style state (set once by factory) ──
    address public factory;
    address public token0;
    address public token1;

    // ── Reserves (packed into one slot with timestamp) ──
    uint112 private reserve0;
    uint112 private reserve1;
    uint32  private blockTimestampLast;

    // ── TWAP accumulators ──
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    // ── Protocol-fee tracking ──
    uint256 public kLast; // reserve0 * reserve1 as of last mint/burn

    // ── Reentrancy guard ──
    uint256 private _unlocked = 1;
    modifier lock() {
        require(_unlocked == 1, "UniswapV2: LOCKED");
        _unlocked = 0;
        _;
        _unlocked = 1;
    }

    // ── Events ──
    event Mint (address indexed sender, uint256 amount0, uint256 amount1);
    event Burn (address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap (
        address indexed sender,
        uint256 amount0In, uint256 amount1In,
        uint256 amount0Out, uint256 amount1Out,
        address indexed to
    );
    event Sync(uint112 reserve0, uint112 reserve1);

    // ─────────────────────────────────────────────
    //  Init
    // ─────────────────────────────────────────────

    constructor() { factory = msg.sender; }

    /// @notice Called once by factory immediately after deployment
    function initialize(address _token0, address _token1) external {
        require(msg.sender == factory, "UniswapV2: FORBIDDEN");
        token0 = _token0;
        token1 = _token1;
    }

    // ─────────────────────────────────────────────
    //  View helpers
    // ─────────────────────────────────────────────

    function getReserves() public view returns (
        uint112 _reserve0,
        uint112 _reserve1,
        uint32  _blockTimestampLast
    ) {
        _reserve0          = reserve0;
        _reserve1          = reserve1;
        _blockTimestampLast = blockTimestampLast;
    }

    // ─────────────────────────────────────────────
    //  Internal helpers
    // ─────────────────────────────────────────────

    /// @dev Low-level token balance query (avoids importing IERC20)
    function _balance(address token) private view returns (uint256 bal) {
        (bool ok, bytes memory data) = token.staticcall(
            abi.encodeWithSignature("balanceOf(address)", address(this))
        );
        require(ok && data.length >= 32, "UniswapV2: BALANCE_QUERY_FAILED");
        bal = abi.decode(data, (uint256));
    }

    /// @dev Low-level token transfer (handles non-standard ERC-20s that return nothing)
    function _safeTransfer(address token, address to, uint256 value) private {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSignature("transfer(address,uint256)", to, value)
        );
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "UniswapV2: TRANSFER_FAILED");
    }

    /// @dev Update reserves and TWAP accumulators.
    ///      The TWAP arithmetic intentionally wraps — use unchecked.
    function _update(
        uint256 bal0, uint256 bal1,
        uint112 _reserve0, uint112 _reserve1
    ) private {
        require(bal0 <= type(uint112).max && bal1 <= type(uint112).max, "UniswapV2: OVERFLOW");

        uint32 ts        = uint32(block.timestamp % 2**32);
        uint32 elapsed;
        unchecked { elapsed = ts - blockTimestampLast; }

        if (elapsed > 0 && _reserve0 != 0 && _reserve1 != 0) {
            // Fixed-point 112.112 price * seconds  (wrapping overflow is intentional)
            unchecked {
                price0CumulativeLast += (uint256(_reserve1) * 2**112 / uint256(_reserve0)) * elapsed;
                price1CumulativeLast += (uint256(_reserve0) * 2**112 / uint256(_reserve1)) * elapsed;
            }
        }

        reserve0           = uint112(bal0);
        reserve1           = uint112(bal1);
        blockTimestampLast = ts;
        emit Sync(reserve0, reserve1);
    }

    /// @dev Collect protocol fee (1/6 of earned fee) by minting LP tokens to feeTo.
    ///      Only active when factory.feeTo != address(0).
    function _mintFee(uint112 _reserve0, uint112 _reserve1) private returns (bool feeOn) {
        address feeTo = IFactory(factory).feeTo();
        feeOn = feeTo != address(0);

        uint256 _kLast = kLast;
        if (feeOn) {
            if (_kLast != 0) {
                uint256 rootK     = _sqrt(uint256(_reserve0) * uint256(_reserve1));
                uint256 rootKLast = _sqrt(_kLast);
                if (rootK > rootKLast) {
                    // Fee = totalSupply * (rootK - rootKLast) / (5*rootK + rootKLast)
                    uint256 num   = totalSupply * (rootK - rootKLast);
                    uint256 denom = rootK * 5 + rootKLast;
                    uint256 fee   = num / denom;
                    if (fee > 0) _mint(feeTo, fee);
                }
            }
        } else if (_kLast != 0) {
            kLast = 0;
        }
    }

    // ─────────────────────────────────────────────
    //  Core functions
    // ─────────────────────────────────────────────

    /// @notice Add liquidity.  Caller must have transferred both tokens to this contract first.
    ///         Returns LP tokens minted.
    ///         First mint burns MINIMUM_LIQUIDITY to address(0) to prevent price manipulation.
    function mint(address to) external lock returns (uint256 liquidity) {
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        uint256 bal0    = _balance(token0);
        uint256 bal1    = _balance(token1);
        uint256 amount0 = bal0 - uint256(_reserve0);
        uint256 amount1 = bal1 - uint256(_reserve1);

        bool feeOn = _mintFee(_reserve0, _reserve1);
        uint256 supply = totalSupply;

        if (supply == 0) {
            // Initial deposit: geometric mean, minus permanently locked minimum
            liquidity = _sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
            _mint(address(0), MINIMUM_LIQUIDITY);
        } else {
            // Subsequent: proportional to smaller contribution
            liquidity = _min(
                amount0 * supply / uint256(_reserve0),
                amount1 * supply / uint256(_reserve1)
            );
        }

        require(liquidity > 0, "UniswapV2: INSUFFICIENT_LIQUIDITY_MINTED");
        _mint(to, liquidity);

        _update(bal0, bal1, _reserve0, _reserve1);
        if (feeOn) kLast = uint256(reserve0) * uint256(reserve1);
        emit Mint(msg.sender, amount0, amount1);
    }

    /// @notice Remove liquidity.  Caller must have sent LP tokens to this contract first.
    ///         Returns both underlying token amounts.
    function burn(address to) external lock returns (uint256 amount0, uint256 amount1) {
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        uint256 bal0      = _balance(token0);
        uint256 bal1      = _balance(token1);
        uint256 liquidity = balanceOf[address(this)]; // LP tokens sent here before calling burn

        bool    feeOn  = _mintFee(_reserve0, _reserve1);
        uint256 supply = totalSupply;

        // Proportional share of reserves
        amount0 = liquidity * bal0 / supply;
        amount1 = liquidity * bal1 / supply;
        require(amount0 > 0 && amount1 > 0, "UniswapV2: INSUFFICIENT_LIQUIDITY_BURNED");

        _burn(address(this), liquidity);
        _safeTransfer(token0, to, amount0);
        _safeTransfer(token1, to, amount1);

        bal0 = _balance(token0);
        bal1 = _balance(token1);
        _update(bal0, bal1, _reserve0, _reserve1);
        if (feeOn) kLast = uint256(reserve0) * uint256(reserve1);
        emit Burn(msg.sender, amount0, amount1, to);
    }

    /// @notice Swap tokens.
    ///         Exactly one of amount0Out / amount1Out must be > 0.
    ///         Input tokens must be sent to this contract BEFORE calling swap.
    ///         Pass non-empty data to trigger a flash swap (IUniswapV2Callee callback).
    ///
    ///  Fee enforcement:
    ///    The 0.3 % fee is enforced via the constant-product check:
    ///    (balance0 * 1000 − amount0In * 3) * (balance1 * 1000 − amount1In * 3) ≥ reserve0 * reserve1 * 1000²
    function swap(
        uint256 amount0Out,
        uint256 amount1Out,
        address to,
        bytes calldata data
    ) external lock {
        require(amount0Out > 0 || amount1Out > 0, "UniswapV2: INSUFFICIENT_OUTPUT_AMOUNT");
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        require(amount0Out < uint256(_reserve0) && amount1Out < uint256(_reserve1), "UniswapV2: INSUFFICIENT_LIQUIDITY");
        require(to != token0 && to != token1, "UniswapV2: INVALID_TO");

        // Send output tokens first (flash-swap pattern)
        if (amount0Out > 0) _safeTransfer(token0, to, amount0Out);
        if (amount1Out > 0) _safeTransfer(token1, to, amount1Out);

        // Flash-swap callback (skip if no data)
        if (data.length > 0) IUniswapV2Callee(to).uniswapV2Call(msg.sender, amount0Out, amount1Out, data);

        // Verify K invariant and update reserves in a helper to avoid "stack too deep"
        (uint256 in0, uint256 in1) = _verifyAndUpdate(amount0Out, amount1Out, _reserve0, _reserve1);
        emit Swap(msg.sender, in0, in1, amount0Out, amount1Out, to);
    }

    /// @dev Reads post-swap balances, enforces x*y=k with 0.3% fee, updates reserves.
    ///      Extracted from swap() to keep the caller's stack under the EVM limit.
    function _verifyAndUpdate(
        uint256 amount0Out,
        uint256 amount1Out,
        uint112 _reserve0,
        uint112 _reserve1
    ) private returns (uint256 in0, uint256 in1) {
        uint256 bal0 = _balance(token0);
        uint256 bal1 = _balance(token1);

        // Derive how much was deposited as input
        in0 = bal0 > uint256(_reserve0) - amount0Out ? bal0 - (uint256(_reserve0) - amount0Out) : 0;
        in1 = bal1 > uint256(_reserve1) - amount1Out ? bal1 - (uint256(_reserve1) - amount1Out) : 0;
        require(in0 > 0 || in1 > 0, "UniswapV2: INSUFFICIENT_INPUT_AMOUNT");

        // Enforce x * y = k with 0.3 % fee deducted from input
        uint256 adj0 = bal0 * 1000 - in0 * 3;
        uint256 adj1 = bal1 * 1000 - in1 * 3;
        require(adj0 * adj1 >= uint256(_reserve0) * uint256(_reserve1) * 1_000_000, "UniswapV2: K");

        _update(bal0, bal1, _reserve0, _reserve1);
    }

    /// @notice Force balances to match reserves (skim excess tokens to `to`)
    function skim(address to) external lock {
        _safeTransfer(token0, to, _balance(token0) - uint256(reserve0));
        _safeTransfer(token1, to, _balance(token1) - uint256(reserve1));
    }

    /// @notice Force reserves to match balances (in case tokens were sent directly)
    function sync() external lock {
        _update(_balance(token0), _balance(token1), reserve0, reserve1);
    }

    // ─────────────────────────────────────────────
    //  Pure math helpers
    // ─────────────────────────────────────────────

    function _sqrt(uint256 y) private pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) { z = x; x = (y / x + x) / 2; }
        } else if (y != 0) {
            z = 1;
        }
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
