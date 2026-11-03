// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IDexRouter} from "../interfaces/IDexRouter.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @notice Local stand-in for a spot venue: swaps stock <-> USDC at oracle spot plus a fee,
/// out of its own inventory. Seed it by transferring tokens to it.
contract MockDex is IDexRouter {
    using SafeERC20 for IERC20;

    IPriceOracle public immutable oracle;
    address public immutable usdc;
    uint256 public feeBps = 5;

    error Slippage();

    constructor(IPriceOracle oracle_, address usdc_) {
        oracle = oracle_;
        usdc = usdc_;
    }

    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256 out)
    {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        if (tokenIn == usdc) {
            (uint256 px,) = oracle.spot(tokenOut);
            out = Math.mulDiv(amountIn, 1e18, px);
        } else {
            (uint256 px,) = oracle.spot(tokenIn);
            out = Math.mulDiv(amountIn, px, 1e18);
        }
        out = out * (10_000 - feeBps) / 10_000;
        if (out < minOut) revert Slippage();
        IERC20(tokenOut).safeTransfer(to, out);
    }
}
