// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IKuruAccountCore, IKuruMarket} from "../interfaces/IKuru.sol";

/// @notice Test-only. Answers one question: can a smart contract (not an EOA) own a Kuru account and trade
/// from it? It deposits into AccountCore as its own root owner, swaps on a market with its own account id,
/// and withdraws to an external recipient. `hedge` does all three in one call, the way an adapter would
/// inside HedgedMaker.onFill.
contract KuruAccountProbe {
    using SafeERC20 for IERC20;

    IKuruAccountCore public immutable core;

    constructor(IKuruAccountCore core_) {
        core = core_;
    }

    function rootId() public view returns (uint40) {
        return core.rootAccountIdOf(address(this));
    }

    /// Deposit tokens this contract holds into its own Kuru account (creates the root on first deposit).
    function deposit(address token, uint256 amount) public {
        IERC20(token).forceApprove(address(core), amount);
        core.deposit(address(this), token, amount);
    }

    function swap(IKuruMarket market, bool isBuy, uint128 amountIn, uint128 minOut)
        public
        returns (uint128 used, uint128 out)
    {
        (used, out) = market.swap(rootId(), isBuy, amountIn, minOut, uint64(block.timestamp + 60));
    }

    function withdraw(address token, uint256 amount, address to) public {
        core.withdraw(rootId(), token, amount, to);
    }

    /// One transaction: pull tokenIn from the caller, deposit, market swap, withdraw the output and any
    /// unspent input to `to`. Leaves nothing in this contract or its Kuru account.
    function hedge(IKuruMarket market, address tokenIn, address tokenOut, bool isBuy, uint128 amountIn, uint128 minOut, address to)
        external
        returns (uint128 out)
    {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        deposit(tokenIn, amountIn);
        uint128 used;
        (used, out) = swap(market, isBuy, amountIn, minOut);
        withdraw(tokenOut, out, to);
        if (used < amountIn) withdraw(tokenIn, amountIn - used, to);
    }
}
