// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OptionsProtocol} from "../OptionsProtocol.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @title ShieldedLender (composability example)
/// @notice A minimal stock-backed lending market that plugs into the options book.
/// Borrowers can buy a Floor in the same transaction, from inside the lender, and the lender
/// counts floored shares at max(spot, strike). A weekend crash that would liquidate an
/// unprotected loan leaves a floored loan healthy. If the price stays low, the borrower can
/// exercise the Floor through the lender and repay with the strike.
/// This is a demo of how Aave-style xStock markets could use the protocol, not a production lender.
contract ShieldedLender is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    OptionsProtocol public immutable protocol;
    IERC20 public immutable asset;
    IERC20 public immutable usdc;
    IPriceOracle public immutable oracle;

    uint256 public constant MAX_LTV_BPS = 5000;
    uint256 public constant LIQ_THRESHOLD_BPS = 6500;

    struct Account {
        uint256 collateral; // stock token
        uint256 debt; // USDC
        uint256 floorSeries;
        uint256 floorAmount; // option tokens held here for the user
    }

    mapping(address => Account) public accounts;

    event CollateralIn(address indexed user, uint256 amount);
    event CollateralOut(address indexed user, uint256 amount);
    event Borrowed(address indexed user, uint256 amount);
    event Repaid(address indexed user, uint256 amount);
    event FloorBought(address indexed user, uint256 seriesId, uint256 amount, uint256 premium);
    event FloorUsed(address indexed user, uint256 amount, uint256 usdcOut);
    event Liquidated(address indexed user, address indexed liquidator, uint256 debt, uint256 collateral);

    error Unhealthy();
    error Healthy();
    error BadFloor();

    constructor(OptionsProtocol protocol_, IERC20 asset_, address owner_) Ownable(owner_) {
        protocol = protocol_;
        asset = asset_;
        usdc = protocol_.usdc();
        oracle = protocol_.oracle();
        usdc.forceApprove(address(protocol_), type(uint256).max);
        asset_.forceApprove(address(protocol_), type(uint256).max);
    }

    /// @notice Owner seeds USDC liquidity to lend.
    function fund(uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    function depositCollateral(uint256 amount) external nonReentrant {
        asset.safeTransferFrom(msg.sender, address(this), amount);
        accounts[msg.sender].collateral += amount;
        emit CollateralIn(msg.sender, amount);
    }

    function borrow(uint256 amount) external nonReentrant {
        Account storage a = accounts[msg.sender];
        a.debt += amount;
        if (a.debt * 10_000 > collateralValue(msg.sender) * MAX_LTV_BPS) revert Unhealthy();
        usdc.safeTransfer(msg.sender, amount);
        emit Borrowed(msg.sender, amount);
    }

    function repay(uint256 amount) external nonReentrant {
        Account storage a = accounts[msg.sender];
        if (amount > a.debt) amount = a.debt;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        a.debt -= amount;
        emit Repaid(msg.sender, amount);
    }

    function withdrawCollateral(uint256 amount) external nonReentrant {
        Account storage a = accounts[msg.sender];
        a.collateral -= amount;
        if (a.debt * 10_000 > collateralValue(msg.sender) * MAX_LTV_BPS) revert Unhealthy();
        asset.safeTransfer(msg.sender, amount);
        emit CollateralOut(msg.sender, amount);
    }

    /// @notice One call: pay premium, buy a Floor from the onchain book, attach it to the loan.
    function buyFloor(uint256 seriesId, uint256 amount, uint256 maxPremium) external nonReentrant {
        OptionsProtocol.Series memory s = protocol.getSeries(seriesId);
        if (s.isCall || s.underlying != address(asset) || block.timestamp >= s.expiry) revert BadFloor();
        Account storage a = accounts[msg.sender];
        if (a.floorAmount > 0 && a.floorSeries != seriesId) {
            OptionsProtocol.Series memory old = protocol.getSeries(a.floorSeries);
            if (block.timestamp < old.expiry) revert BadFloor();
            a.floorAmount = 0; // expired floor, already worthless or redeemable by owner sweep
        }
        (uint256 premium,) = protocol.quoteBuy(seriesId, amount);
        usdc.safeTransferFrom(msg.sender, address(this), premium);
        uint256 paid = protocol.buy(seriesId, amount, maxPremium, address(this));
        a.floorSeries = seriesId;
        a.floorAmount += amount;
        emit FloorBought(msg.sender, seriesId, amount, paid);
    }

    /// @notice Shares covered by a live Floor count at max(spot, strike).
    function collateralValue(address user) public view returns (uint256) {
        Account storage a = accounts[user];
        (uint256 px,) = oracle.spot(address(asset));
        uint256 covered;
        uint256 strike;
        if (a.floorAmount > 0) {
            OptionsProtocol.Series memory s = protocol.getSeries(a.floorSeries);
            if (block.timestamp < s.expiry) {
                covered = Math.min(a.floorAmount, a.collateral);
                strike = s.strike;
            }
        }
        uint256 protectedPx = px > strike ? px : strike;
        return Math.mulDiv(covered, protectedPx, 1e18) + Math.mulDiv(a.collateral - covered, px, 1e18);
    }

    function healthBps(address user) external view returns (uint256) {
        uint256 v = collateralValue(user);
        if (accounts[user].debt == 0) return type(uint256).max;
        return v * LIQ_THRESHOLD_BPS / accounts[user].debt;
    }

    function isLiquidatable(address user) public view returns (bool) {
        return accounts[user].debt * 10_000 > collateralValue(user) * LIQ_THRESHOLD_BPS;
    }

    /// @notice Borrower exercises the Floor through the lender: shares go in at the strike, USDC repays the loan.
    function useFloor(uint256 amount) external nonReentrant {
        Account storage a = accounts[msg.sender];
        if (amount > a.floorAmount || amount > a.collateral) revert BadFloor();
        uint256 before = usdc.balanceOf(address(this));
        protocol.exercise(a.floorSeries, amount);
        uint256 got = usdc.balanceOf(address(this)) - before;
        a.floorAmount -= amount;
        a.collateral -= amount;
        uint256 toDebt = got > a.debt ? a.debt : got;
        a.debt -= toDebt;
        if (got > toDebt) usdc.safeTransfer(msg.sender, got - toDebt);
        emit FloorUsed(msg.sender, amount, got);
    }

    function liquidate(address user) external nonReentrant {
        if (!isLiquidatable(user)) revert Healthy();
        Account storage a = accounts[user];
        uint256 debt = a.debt;
        uint256 coll = a.collateral;
        usdc.safeTransferFrom(msg.sender, address(this), debt);
        a.debt = 0;
        a.collateral = 0;
        asset.safeTransfer(msg.sender, coll);
        if (a.floorAmount > 0) {
            OptionsProtocol.Series memory s = protocol.getSeries(a.floorSeries);
            IERC20(address(s.token)).safeTransfer(msg.sender, a.floorAmount);
            a.floorAmount = 0;
        }
        emit Liquidated(user, msg.sender, debt, coll);
    }
}
