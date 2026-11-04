// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IDexRouter} from "../interfaces/IDexRouter.sol";
import {IKuruAccountCore, IKuruMarket} from "../interfaces/IKuru.sol";

/// @title KuruAdapter
/// @notice IDexRouter over Kuru's spot order books, so HedgedMaker can hedge on Kuru inside the buyer's transaction.
/// Kuru trades from AccountCore balances, so each swap runs three steps in one call: deposit the input into this
/// contract's own Kuru account, take liquidity on the market with an exact-input swap, then withdraw the output
/// to `to` and any unspent input back to the caller. Nothing stays in the adapter or its Kuru account.
/// Every pair is stock <-> USDC on one market: USDC in buys the stock, stock in sells it.
contract KuruAdapter is IDexRouter, Ownable2Step {
    using SafeERC20 for IERC20;

    IKuruAccountCore public immutable core;
    address public immutable usdc;

    /// @notice stock token -> its Kuru stock/USDC market. Set by the owner.
    mapping(address => IKuruMarket) public marketOf;

    event MarketSet(address indexed stock, address market);

    error NoMarket();
    error WrongMarket();
    error Slippage();

    constructor(IKuruAccountCore core_, address usdc_, address owner_) Ownable(owner_) {
        core = core_;
        usdc = usdc_;
    }

    function setMarket(address stock, IKuruMarket market) external onlyOwner {
        if (address(market) != address(0) && (market.baseToken() != stock || market.quoteToken() != usdc)) revert WrongMarket();
        marketOf[stock] = market;
        emit MarketSet(stock, address(market));
    }

    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256 amountOut)
    {
        bool isBuy = tokenIn == usdc;
        if (!isBuy && tokenOut != usdc) revert NoMarket(); // stock -> stock is not a single market
        IKuruMarket market = marketOf[isBuy ? tokenOut : tokenIn];
        if (address(market) == address(0)) revert NoMarket();

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(address(core), amountIn);
        core.deposit(address(this), tokenIn, amountIn);
        uint40 id = core.rootAccountIdOf(address(this));

        (uint128 used, uint128 out) =
            market.swap(id, isBuy, SafeCast.toUint128(amountIn), SafeCast.toUint128(minOut), uint64(block.timestamp));
        if (out < minOut) revert Slippage();
        amountOut = out;

        core.withdraw(id, tokenOut, amountOut, to);
        if (used < amountIn) core.withdraw(id, tokenIn, amountIn - used, msg.sender);
    }
}
