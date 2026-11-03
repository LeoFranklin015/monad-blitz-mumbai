// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal spot venue interface used for atomic hedging.
/// On Monad this is implemented by a thin adapter over Kuru's order book router (or 0x / Uniswap).
interface IDexRouter {
    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256 amountOut);
}
