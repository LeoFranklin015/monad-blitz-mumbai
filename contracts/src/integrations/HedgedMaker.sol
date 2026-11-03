// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OptionsProtocol} from "../core/OptionsProtocol.sol";
import {IFillHook} from "../interfaces/IFillHook.sol";
import {IDexRouter} from "../interfaces/IDexRouter.sol";

/// @title HedgedMaker
/// @notice A market-making contract that hedges every fill on spot inside the same transaction.
/// The operator bot sets a hedge ratio per series (stock tokens per option, signed, from the
/// option delta). When a buyer lifts one of its quotes, the protocol calls onFill and the maker
/// buys or sells the stock right away, so it is never unhedged, not even for a block.
/// That is what lets it quote tighter than a maker who hedges a block later.
/// If the hedge cannot execute (no inventory, bad price), the fill still goes through and the
/// maker emits HedgeSkipped; buyers are never blocked by a maker's hedge.
contract HedgedMaker is IFillHook, Ownable2Step {
    using SafeERC20 for IERC20;

    OptionsProtocol public immutable protocol;
    IERC20 public immutable usdc;
    IDexRouter public dex;
    address public operator;
    uint256 public maxSlippageBps = 100;

    /// @notice stock tokens (1e18) to trade per 1e18 options sold. Positive buys stock, negative sells.
    mapping(uint256 => int256) public hedgePerOption;

    event Hedged(uint256 indexed seriesId, uint256 options, int256 stockDelta, uint256 amountIn, uint256 amountOut);
    event HedgeSkipped(uint256 indexed seriesId, uint256 options, int256 stockDelta);

    error NotOperator();
    error NotProtocol();

    constructor(OptionsProtocol protocol_, IDexRouter dex_, address owner_, address operator_) Ownable(owner_) {
        protocol = protocol_;
        usdc = protocol_.usdc();
        dex = dex_;
        operator = operator_;
    }

    /// @notice Register for fill callbacks. Called once after deploy (a contract has no code inside its constructor).
    function setHook(bool on) external onlyOwner {
        protocol.setFillHook(on);
    }

    modifier onlyOperator() {
        if (msg.sender != operator && msg.sender != owner()) revert NotOperator();
        _;
    }

    // ---------------------------------------------------------------- admin

    function setOperator(address o) external onlyOwner {
        operator = o;
    }

    function setDex(IDexRouter d) external onlyOwner {
        dex = d;
    }

    function setMaxSlippage(uint256 bps) external onlyOwner {
        maxSlippageBps = bps;
    }

    function sweep(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------- operator: inventory and quotes

    function depositToProtocol(address token, uint256 amount) external onlyOperator {
        IERC20(token).forceApprove(address(protocol), amount);
        protocol.deposit(token, amount);
    }

    function withdrawFromProtocol(address token, uint256 amount) external onlyOperator {
        protocol.withdraw(token, amount);
    }

    function postQuote(uint256 id, uint128 price, uint128 size) external onlyOperator returns (uint256) {
        return protocol.postQuote(id, price, size);
    }

    function postQuotes(uint256[] calldata ids, bool[] calldata isBid, uint128[] calldata prices, uint128[] calldata sizes)
        external
        onlyOperator
    {
        protocol.postQuotes(ids, isBid, prices, sizes);
    }

    function updateQuotes(uint256[] calldata ids, uint128[] calldata prices, uint128[] calldata sizes) external onlyOperator {
        protocol.updateQuotes(ids, prices, sizes);
    }

    function cancelQuote(uint256 quoteId) external onlyOperator {
        protocol.cancelQuote(quoteId);
    }

    function claim(uint256 id) external onlyOperator {
        protocol.claim(id);
    }

    function setHedges(uint256[] calldata ids, int256[] calldata perOption) external onlyOperator {
        for (uint256 i; i < ids.length; ++i) hedgePerOption[ids[i]] = perOption[i];
    }

    // ---------------------------------------------------------------- hook

    function onFill(uint256 seriesId, uint256 amount, uint256) external {
        if (msg.sender != address(protocol)) revert NotProtocol();
        int256 h = hedgePerOption[seriesId];
        if (h == 0) return;
        uint256 qty = Math.mulDiv(amount, uint256(h > 0 ? h : -h), 1e18);
        int256 delta = h > 0 ? int256(qty) : -int256(qty);
        address stock = protocol.getSeries(seriesId).underlying;
        (uint256 px,) = protocol.oracle().spot(stock);
        if (qty == 0 || px == 0) {
            emit HedgeSkipped(seriesId, amount, delta);
            return;
        }

        uint256 notional = Math.mulDiv(qty, px, 1e18);
        address tin;
        address tout;
        uint256 amtIn;
        uint256 minOut;
        if (h > 0) {
            (tin, tout, amtIn) = (address(usdc), stock, notional);
            minOut = qty * (10_000 - maxSlippageBps) / 10_000;
        } else {
            (tin, tout, amtIn) = (stock, address(usdc), qty);
            minOut = notional * (10_000 - maxSlippageBps) / 10_000;
        }
        if (IERC20(tin).balanceOf(address(this)) < amtIn) {
            emit HedgeSkipped(seriesId, amount, delta);
            return;
        }
        IERC20(tin).forceApprove(address(dex), amtIn);
        try dex.swapExactIn(tin, tout, amtIn, minOut, address(this)) returns (uint256 out) {
            emit Hedged(seriesId, amount, delta, amtIn, out);
        } catch {
            IERC20(tin).forceApprove(address(dex), 0);
            emit HedgeSkipped(seriesId, amount, delta);
        }
    }
}
