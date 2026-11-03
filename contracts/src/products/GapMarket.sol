// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @title GapMarket
/// @notice Weekend gap market: will the stock open Monday above or below Friday's close?
/// Pooled (parimutuel) USDC on each side. Betting is open over the weekend and closes at Monday open.
/// Settles on the same time-weighted Monday-open price the options use.
/// The live UP/DOWN split is a public weekend price signal that option makers can quote from.
contract GapMarket is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Round {
        address asset;
        uint64 openTime; // Friday close
        uint64 lockTime; // Monday open, also the oracle expiry key
        uint256 refPrice; // Friday close price
        uint256 upPool;
        uint256 downPool;
        bool settled;
        uint256 settlePrice;
        uint8 outcome; // 0 none, 1 up, 2 down, 3 refund
    }

    IERC20 public immutable usdc;
    IPriceOracle public immutable oracle;
    uint256 public feeBps = 100;
    uint256 public constant MAX_FEE_BPS = 500;
    uint256 public constant GRACE = 7 days;

    Round[] public rounds;
    address public guardian;
    address public opener; // keeper that opens weekly rounds
    bool public paused;
    mapping(uint256 => mapping(address => uint256)) public upStake;
    mapping(uint256 => mapping(address => uint256)) public downStake;

    event RoundOpened(uint256 indexed id, address indexed asset, uint64 openTime, uint64 lockTime, uint256 refPrice);
    event Bet(uint256 indexed id, address indexed user, bool up, uint256 amount);
    event RoundSettled(uint256 indexed id, uint256 price, uint8 outcome);
    event Claimed(uint256 indexed id, address indexed user, uint256 amount);

    error BadRound();
    error Locked();
    error NotLocked();
    error OracleNotReady();
    error Nothing();
    error IsPaused();
    error NotGuardian();

    event Paused(bool paused);

    constructor(IERC20 usdc_, IPriceOracle oracle_, address owner_) Ownable(owner_) {
        usdc = usdc_;
        oracle = oracle_;
        guardian = owner_;
    }

    function setGuardian(address g) external onlyOwner {
        guardian = g;
    }

    function setOpener(address o) external onlyOwner {
        opener = o;
    }

    /// @notice Stops new bets only. Settling and claiming always work.
    function pause() external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        paused = true;
        emit Paused(true);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Paused(false);
    }

    function setFee(uint256 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert BadRound();
        feeBps = bps;
    }

    function roundCount() external view returns (uint256) {
        return rounds.length;
    }

    function openRound(address asset, uint64 openTime, uint64 lockTime, uint256 refPrice)
        external
        returns (uint256 id)
    {
        if (msg.sender != owner() && msg.sender != opener) revert NotGuardian();
        if (lockTime <= openTime || refPrice == 0) revert BadRound();
        id = rounds.length;
        rounds.push(Round(asset, openTime, lockTime, refPrice, 0, 0, false, 0, 0));
        emit RoundOpened(id, asset, openTime, lockTime, refPrice);
    }

    function bet(uint256 id, bool up, uint256 amount) external nonReentrant {
        if (paused) revert IsPaused();
        Round storage r = rounds[id];
        if (block.timestamp >= r.lockTime) revert Locked();
        if (amount == 0) revert Nothing();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        if (up) {
            r.upPool += amount;
            upStake[id][msg.sender] += amount;
        } else {
            r.downPool += amount;
            downStake[id][msg.sender] += amount;
        }
        emit Bet(id, msg.sender, up, amount);
    }

    /// @notice Implied probability the stock gaps up, in bps. 5000 when the pool is empty.
    function impliedUpBps(uint256 id) external view returns (uint256) {
        Round storage r = rounds[id];
        uint256 total = r.upPool + r.downPool;
        if (total == 0) return 5000;
        return r.upPool * 10_000 / total;
    }

    function settle(uint256 id) public {
        Round storage r = rounds[id];
        if (r.settled) revert BadRound();
        if (block.timestamp < r.lockTime) revert NotLocked();
        (uint256 p, bool ok) = oracle.settlementPrice(r.asset, r.lockTime);
        uint8 outcome;
        if (!ok) {
            if (block.timestamp < r.lockTime + GRACE) revert OracleNotReady();
            outcome = 3;
        } else if (p > r.refPrice) {
            outcome = r.upPool == 0 ? 3 : 1;
        } else if (p < r.refPrice) {
            outcome = r.downPool == 0 ? 3 : 2;
        } else {
            outcome = 3;
        }
        if (outcome == 1 && r.downPool == 0) outcome = 3;
        if (outcome == 2 && r.upPool == 0) outcome = 3;

        r.settled = true;
        r.settlePrice = p;
        r.outcome = outcome;
        if (outcome == 1 || outcome == 2) {
            uint256 losers = outcome == 1 ? r.downPool : r.upPool;
            uint256 fee = losers * feeBps / 10_000;
            if (fee > 0) usdc.safeTransfer(owner(), fee);
            if (outcome == 1) r.downPool -= fee;
            else r.upPool -= fee;
        }
        emit RoundSettled(id, p, outcome);
    }

    function claim(uint256 id) external nonReentrant returns (uint256 out) {
        Round storage r = rounds[id];
        if (!r.settled) settle(id);
        uint256 u = upStake[id][msg.sender];
        uint256 d = downStake[id][msg.sender];
        upStake[id][msg.sender] = 0;
        downStake[id][msg.sender] = 0;
        if (r.outcome == 3) {
            out = u + d;
        } else if (r.outcome == 1 && u > 0) {
            out = u + Math.mulDiv(r.downPool, u, r.upPool);
        } else if (r.outcome == 2 && d > 0) {
            out = d + Math.mulDiv(r.upPool, d, r.downPool);
        }
        if (out == 0) revert Nothing();
        usdc.safeTransfer(msg.sender, out);
        emit Claimed(id, msg.sender, out);
    }
}
