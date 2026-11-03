// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OptionsProtocol} from "./OptionsProtocol.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";

/// @title CommitVault (Auto-Commit)
/// @notice Deposit a stock token once. Each week the vault writes covered Upsides (calls) on the book,
/// collects premium, and rolls. Rules are fixed in code, so the keeper can only act inside them:
///  - strike at least `minOtmBps` above spot
///  - expiry no further than `maxTenor` away
///  - premium never below `minPremiumBps` of spot
/// Deposits and withdrawals open between rounds. Shares are pro rata of the stock and USDC held.
contract CommitVault is ERC20, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    OptionsProtocol public immutable protocol;
    IERC20 public immutable asset; // stock token
    IERC20 public immutable usdc;
    IPriceOracle public immutable oracle;

    address public keeper;
    uint256 public minOtmBps = 300; // 3% out of the money at least
    uint256 public minPremiumBps = 20; // 0.20% of spot per option at least
    uint64 public maxTenor = 8 days;

    bool public active;
    uint256 public activeSeries;
    uint256 public activeQuote;
    uint256 public roundsCompleted;

    event KeeperSet(address keeper);
    event RulesSet(uint256 minOtmBps, uint256 minPremiumBps, uint64 maxTenor);
    event Deposit(address indexed user, uint256 assets, uint256 shares);
    event Withdraw(address indexed user, uint256 shares, uint256 assetOut, uint256 usdcOut);
    event RoundStarted(uint256 indexed seriesId, uint256 quoteId, uint256 size, uint256 price);
    event RoundRepriced(uint256 indexed seriesId, uint256 price);
    event RoundEnded(uint256 indexed seriesId, uint256 assetBack, uint256 usdcBack);

    error RoundActive();
    error NoRound();
    error NotKeeper();
    error RuleBroken(string why);
    error Zero();

    constructor(OptionsProtocol protocol_, IERC20 asset_, string memory name_, string memory symbol_, address owner_)
        ERC20(name_, symbol_)
        Ownable(owner_)
    {
        protocol = protocol_;
        asset = asset_;
        usdc = protocol_.usdc();
        oracle = protocol_.oracle();
        keeper = owner_;
        asset_.forceApprove(address(protocol_), type(uint256).max);
    }

    modifier onlyKeeper() {
        if (msg.sender != keeper && msg.sender != owner()) revert NotKeeper();
        _;
    }

    function setKeeper(address k) external onlyOwner {
        keeper = k;
        emit KeeperSet(k);
    }

    function setRules(uint256 otm, uint256 prem, uint64 tenor) external onlyOwner {
        minOtmBps = otm;
        minPremiumBps = prem;
        maxTenor = tenor;
        emit RulesSet(otm, prem, tenor);
    }

    // ---------------------------------------------------------------- accounting

    function totalAssets() public view returns (uint256 assetBal, uint256 usdcBal) {
        assetBal = asset.balanceOf(address(this));
        usdcBal = usdc.balanceOf(address(this));
    }

    /// @notice Vault value in stock units, valuing USDC at spot.
    function navInAsset() public view returns (uint256) {
        (uint256 a, uint256 c) = totalAssets();
        if (c == 0) return a;
        (uint256 px,) = oracle.spot(address(asset));
        if (px == 0) return a;
        return a + Math.mulDiv(c, 1e18, px);
    }

    function deposit(uint256 amount) external nonReentrant returns (uint256 shares) {
        if (active) revert RoundActive();
        if (amount == 0) revert Zero();
        uint256 nav = navInAsset();
        uint256 supply = totalSupply();
        asset.safeTransferFrom(msg.sender, address(this), amount);
        shares = supply == 0 || nav == 0 ? amount : Math.mulDiv(amount, supply, nav);
        _mint(msg.sender, shares);
        emit Deposit(msg.sender, amount, shares);
    }

    function withdraw(uint256 shares) external nonReentrant returns (uint256 aOut, uint256 cOut) {
        if (active) revert RoundActive();
        if (shares == 0) revert Zero();
        uint256 supply = totalSupply();
        (uint256 a, uint256 c) = totalAssets();
        aOut = Math.mulDiv(a, shares, supply);
        cOut = Math.mulDiv(c, shares, supply);
        _burn(msg.sender, shares);
        if (aOut > 0) asset.safeTransfer(msg.sender, aOut);
        if (cOut > 0) usdc.safeTransfer(msg.sender, cOut);
        emit Withdraw(msg.sender, shares, aOut, cOut);
    }

    // ---------------------------------------------------------------- rounds

    /// @notice Write covered calls with every stock token the vault holds, at a rule-checked strike and price.
    function startRound(uint256 seriesId, uint128 pricePerOption) external onlyKeeper nonReentrant {
        if (active) revert RoundActive();
        OptionsProtocol.Series memory s = protocol.getSeries(seriesId);
        if (!s.isCall || s.underlying != address(asset)) revert RuleBroken("series");
        if (s.expiry > block.timestamp + maxTenor) revert RuleBroken("tenor");
        (uint256 px,) = oracle.spot(address(asset));
        if (px == 0) revert RuleBroken("no spot");
        if (s.strike < px * (10_000 + minOtmBps) / 10_000) revert RuleBroken("strike too close");
        _checkPremium(pricePerOption, px);

        uint256 size = asset.balanceOf(address(this));
        if (size == 0) revert Zero();
        protocol.deposit(address(asset), size);
        uint256 qid = protocol.postQuote(seriesId, pricePerOption, uint128(size));
        active = true;
        activeSeries = seriesId;
        activeQuote = qid;
        emit RoundStarted(seriesId, qid, size, pricePerOption);
    }

    function reprice(uint128 pricePerOption) external onlyKeeper {
        if (!active) revert NoRound();
        (uint256 px,) = oracle.spot(address(asset));
        _checkPremium(pricePerOption, px);
        OptionsProtocol.Quote memory q = protocol.getQuote(activeQuote);
        if (q.size == 0) return;
        protocol.updateQuote(activeQuote, pricePerOption, q.size);
        emit RoundRepriced(activeSeries, pricePerOption);
    }

    /// @notice After expiry: pull unsold collateral, claim the writer share, bring everything home.
    /// Anyone can call it, so depositors never depend on the keeper to get their funds back.
    function endRound() external nonReentrant {
        if (!active) revert NoRound();
        OptionsProtocol.Series memory s = protocol.getSeries(activeSeries);
        if (block.timestamp < s.expiry) revert RoundActive();

        OptionsProtocol.Quote memory q = protocol.getQuote(activeQuote);
        if (q.size > 0) protocol.cancelQuote(activeQuote);
        protocol.claim(activeSeries);

        uint256 a = protocol.freeBalance(address(this), address(asset));
        uint256 c = protocol.freeBalance(address(this), address(usdc));
        if (a > 0) protocol.withdraw(address(asset), a);
        if (c > 0) protocol.withdraw(address(usdc), c);

        active = false;
        roundsCompleted += 1;
        emit RoundEnded(activeSeries, a, c);
    }

    function _checkPremium(uint256 price, uint256 spotPx) internal view {
        if (price < spotPx * minPremiumBps / 10_000) revert RuleBroken("premium too low");
    }
}
