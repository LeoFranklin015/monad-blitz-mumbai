// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OptionToken, OptionTokenFactory} from "./OptionToken.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";
import {IFillHook} from "../interfaces/IFillHook.sol";

/// @title OptionsProtocol
/// @notice Fully collateralized options on tokenized stocks. No margin, so nothing is ever liquidated.
///
/// Four series kinds:
///  - CALL        "Upside".        Writer locks the stock token. Physical exercise: pay strike, take stock.
///  - PUT         "Floor".         Writer locks strike in USDC. Physical exercise: give stock, take strike.
///  - CALL_SPREAD "Capped Upside". Pays max(0, P - K) capped at K2 - K. Writer locks only the width in USDC.
///  - PUT_SPREAD  "Budget Floor".  Pays max(0, K - P) capped at K - K2. Writer locks only the width in USDC.
///
/// Exercise of CALL and PUT never reads an oracle. An oracle is read once, after expiry, to
/// settle whatever nobody exercised.
///
/// Trading, all onchain: a two-sided book per series (asks backed by writer collateral, bids by USDC),
/// signed EIP-712 RFQs from EOAs or ERC-1271 accounts, and the option ERC-20s themselves.
/// Maker contracts can register a fill hook to hedge on spot in the same transaction.
///
/// Safety properties:
///  - Every quote and every open option is fully backed by tokens held here.
///  - Pausing (guardian) stops new risk only. Withdraw, cancel, exercise, close, sell-to-close,
///    settle, redeem and claim always work.
///  - A maker's hook can never block a fill: it runs with a fixed gas budget inside try/catch.
///  - Underlying tokens must be non-rebasing (use wrapped xStocks). Inbound transfers are
///    measured, so fee-on-transfer tokens cannot under-collateralize a series.
///
/// Units: stock and option amounts 18 decimals (1e18 = one token). Strikes and prices are
/// USDC (6 decimals) per 1e18 units.
contract OptionsProtocol is Ownable2Step, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- types

    enum Kind {
        CALL,
        PUT,
        CALL_SPREAD,
        PUT_SPREAD
    }

    struct Series {
        address underlying;
        uint64 expiry;
        Kind kind;
        uint256 strike;
        uint256 strike2; // cap for CALL_SPREAD (> strike), floor for PUT_SPREAD (< strike), 0 otherwise
        OptionToken token;
        uint256 totalWritten;
        uint256 poolUnderlying;
        uint256 poolCash;
        bool settled;
        uint256 settlePrice;
        uint256 supplyAtSettle;
        uint256 holderUnderlying;
        uint256 holderCash;
        uint256 writerUnderlying;
        uint256 writerCash;
        uint256 writtenAtSettle;
    }

    struct Quote {
        address maker;
        uint64 seriesId;
        bool isBid;
        uint128 price; // USDC per 1e18 options
        uint128 size; // options left
        uint256 reserved; // collateral (asks) or USDC (bids) held for this quote
    }

    struct RFQ {
        address maker;
        uint256 seriesId;
        uint256 price;
        uint256 maxSize;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 public constant RFQ_TYPEHASH =
        keccak256("RFQ(address maker,uint256 seriesId,uint256 price,uint256 maxSize,uint256 nonce,uint256 deadline)");

    uint256 public constant MAX_QUOTES_PER_SIDE = 64;
    uint256 public constant MIN_QUOTE_SIZE = 1e16; // 0.01 options
    uint256 public constant SETTLEMENT_GRACE = 7 days;
    uint256 public constant MAX_TENOR = 400 days;
    uint256 public constant MAX_FEE_BPS = 100;
    uint256 public constant MAX_HOOK_GAS = 2_000_000;

    // ---------------------------------------------------------------- state

    IERC20 public immutable usdc;
    OptionTokenFactory public immutable tokenFactory;
    IPriceOracle public oracle;
    address public treasury;
    address public guardian;
    bool public paused;
    uint256 public feeBps = 10;
    uint256 public hookGas = 600_000;

    mapping(address => bool) public allowedUnderlying;
    mapping(address => bool) public fillHook;

    Series[] internal _series;
    mapping(bytes32 => uint256) public seriesIdOf; // key => id + 1

    mapping(address => mapping(address => uint256)) public freeBalance;
    mapping(uint256 => mapping(address => uint256)) public written;

    Quote[] internal _quotes;
    mapping(uint256 => uint256[]) internal _asks;
    mapping(uint256 => uint256[]) internal _bids;
    mapping(uint256 => uint256) internal _bookIndex; // quoteId => index + 1
    mapping(address => uint256[]) internal _makerQuotes;

    mapping(bytes32 => uint256) public rfqFilled;
    mapping(address => mapping(uint256 => bool)) public rfqCancelled;

    // ---------------------------------------------------------------- events

    event UnderlyingAllowed(address indexed asset, bool allowed);
    event OracleSet(address indexed oracle);
    event FeeSet(uint256 feeBps, address indexed treasury);
    event GuardianSet(address indexed guardian);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event HookGasSet(uint256 gas);
    event SeriesCreated(uint256 indexed seriesId, address indexed underlying, uint64 expiry, Kind kind, uint256 strike, uint256 strike2, address token);
    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event QuotePosted(uint256 indexed quoteId, uint256 indexed seriesId, address indexed maker, bool isBid, uint256 price, uint256 size);
    event QuoteUpdated(uint256 indexed quoteId, uint256 price, uint256 size);
    event QuoteCancelled(uint256 indexed quoteId);
    event QuoteEvicted(uint256 indexed quoteId, uint256 indexed byQuoteId);
    event Filled(uint256 indexed seriesId, address indexed seller, address indexed buyer, uint256 amount, uint256 price, uint256 quoteId);
    event RFQFilled(uint256 indexed seriesId, address indexed maker, address indexed buyer, uint256 amount, uint256 price, bytes32 rfqHash);
    event RFQCancelled(address indexed maker, uint256 nonce);
    event Exercised(uint256 indexed seriesId, address indexed holder, uint256 amount);
    event Closed(uint256 indexed seriesId, address indexed writer, uint256 amount);
    event Settled(uint256 indexed seriesId, uint256 price, uint256 holderUnderlying, uint256 holderCash);
    event Redeemed(uint256 indexed seriesId, address indexed holder, uint256 amount, uint256 underlyingOut, uint256 cashOut);
    event WriterClaimed(uint256 indexed seriesId, address indexed writer, uint256 underlyingOut, uint256 cashOut);
    event FillHookSet(address indexed maker, bool on);
    event HookFailed(address indexed maker, uint256 indexed seriesId);

    // ---------------------------------------------------------------- errors

    error NotAllowed();
    error BadSeries();
    error Expired();
    error NotExpired();
    error AlreadySettled();
    error OracleNotReady();
    error BookFull();
    error NotMaker();
    error InsufficientBalance();
    error InsufficientLiquidity();
    error Slippage();
    error BadSignature();
    error BadAmount();
    error NotExercisable();
    error IsPaused();
    error NotGuardian();
    error TransferShortfall();
    error NotContract();
    error LowGas();

    constructor(IERC20 usdc_, IPriceOracle oracle_, address owner_) Ownable(owner_) EIP712("WeekendOptions", "1") {
        usdc = usdc_;
        tokenFactory = new OptionTokenFactory();
        tokenFactory.bind(address(this));
        oracle = oracle_;
        treasury = owner_;
        guardian = owner_;
    }

    modifier whenNotPaused() {
        if (paused) revert IsPaused();
        _;
    }

    // ---------------------------------------------------------------- admin

    function setUnderlying(address asset, bool allowed) external onlyOwner {
        if (asset == address(usdc)) revert NotAllowed();
        allowedUnderlying[asset] = allowed;
        emit UnderlyingAllowed(asset, allowed);
    }

    function setOracle(IPriceOracle oracle_) external onlyOwner {
        oracle = oracle_;
        emit OracleSet(address(oracle_));
    }

    function setFee(uint256 feeBps_, address treasury_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS || treasury_ == address(0)) revert BadAmount();
        feeBps = feeBps_;
        treasury = treasury_;
        emit FeeSet(feeBps_, treasury_);
    }

    function setGuardian(address g) external onlyOwner {
        guardian = g;
        emit GuardianSet(g);
    }

    function setHookGas(uint256 g) external onlyOwner {
        if (g > MAX_HOOK_GAS) revert BadAmount();
        hookGas = g;
        emit HookGasSet(g);
    }

    /// @notice Guardian or owner can stop new risk instantly. Exits keep working.
    function pause() external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /// @notice Maker contracts opt in to receive onFill callbacks. Only contracts can opt in.
    function setFillHook(bool on) external {
        if (on && msg.sender.code.length == 0) revert NotContract();
        fillHook[msg.sender] = on;
        emit FillHookSet(msg.sender, on);
    }

    // ---------------------------------------------------------------- series

    /// @notice Permissionless. Anyone can open a series on an allowed stock token.
    function createSeries(address underlying, uint64 expiry, Kind kind, uint256 strike, uint256 strike2)
        external
        whenNotPaused
        returns (uint256 id)
    {
        if (!allowedUnderlying[underlying]) revert NotAllowed();
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_TENOR || strike == 0) revert BadSeries();
        if (kind == Kind.CALL || kind == Kind.PUT) {
            if (strike2 != 0) revert BadSeries();
        } else if (kind == Kind.CALL_SPREAD) {
            if (strike2 <= strike) revert BadSeries();
        } else if (strike2 >= strike || strike2 == 0) {
            revert BadSeries();
        }
        bytes32 key = keccak256(abi.encode(underlying, expiry, kind, strike, strike2));
        if (seriesIdOf[key] != 0) return seriesIdOf[key] - 1;

        id = _series.length;
        string memory tag = _tag(kind);
        OptionToken token = tokenFactory.deploy(string.concat("Weekend ", tag, " #", _u(id)), string.concat(tag, "-", _u(id)), id);
        Series storage s = _series.push();
        s.underlying = underlying;
        s.expiry = expiry;
        s.kind = kind;
        s.strike = strike;
        s.strike2 = strike2;
        s.token = token;
        seriesIdOf[key] = id + 1;
        emit SeriesCreated(id, underlying, expiry, kind, strike, strike2, address(token));
    }

    function seriesCount() external view returns (uint256) {
        return _series.length;
    }

    function getSeries(uint256 id) external view returns (Series memory) {
        return _series[id];
    }

    /// @notice Token and amount a writer must lock for `amount` options.
    function collateralFor(uint256 id, uint256 amount) public view returns (address token, uint256 need) {
        Series storage s = _series[id];
        if (s.kind == Kind.CALL) return (s.underlying, amount);
        return (address(usdc), Math.mulDiv(amount, _cashPerOption(s), 1e18, Math.Rounding.Ceil));
    }

    // ---------------------------------------------------------------- balances

    /// @notice Credits what actually arrived, so fee-on-transfer tokens cannot inflate balances.
    function deposit(address token, uint256 amount) external nonReentrant {
        uint256 got = _pull(token, msg.sender, amount);
        freeBalance[msg.sender][token] += got;
        emit Deposited(msg.sender, token, got);
    }

    function withdraw(address token, uint256 amount) external nonReentrant {
        if (freeBalance[msg.sender][token] < amount) revert InsufficientBalance();
        freeBalance[msg.sender][token] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, token, amount);
    }

    // ---------------------------------------------------------------- order book

    /// @notice Post an ask (offer to write). Collateral moves from free balance into the quote.
    function postQuote(uint256 id, uint128 price, uint128 size) external nonReentrant whenNotPaused returns (uint256) {
        return _post(id, false, price, size);
    }

    /// @notice Post a bid (offer to buy). USDC moves from free balance into the quote.
    function postBid(uint256 id, uint128 price, uint128 size) external nonReentrant whenNotPaused returns (uint256) {
        return _post(id, true, price, size);
    }

    /// @notice Post many quotes in one transaction (asks and bids mixed).
    function postQuotes(uint256[] calldata ids, bool[] calldata isBid, uint128[] calldata prices, uint128[] calldata sizes)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 firstQuoteId)
    {
        if (ids.length != isBid.length || ids.length != prices.length || ids.length != sizes.length) revert BadAmount();
        firstQuoteId = _quotes.length;
        for (uint256 i; i < ids.length; ++i) _post(ids[i], isBid[i], prices[i], sizes[i]);
    }

    /// @notice Reprice and resize in one call. Size 0 cancels.
    function updateQuote(uint256 quoteId, uint128 price, uint128 size) external nonReentrant {
        Quote storage q = _quotes[quoteId];
        if (q.maker != msg.sender) revert NotMaker();
        if (_bookIndex[quoteId] == 0) revert BadAmount();
        if (size == 0) return _cancel(q, quoteId);
        if (paused) revert IsPaused();
        _seriesLive(q.seriesId);
        _update(q, quoteId, price, size);
    }

    /// @notice Batch reprice. Quotes filled, cancelled or expired since the maker last looked are skipped,
    /// so a batch never fails on a race.
    function updateQuotes(uint256[] calldata ids, uint128[] calldata prices, uint128[] calldata sizes)
        external
        nonReentrant
    {
        if (ids.length != prices.length || ids.length != sizes.length) revert BadAmount();
        for (uint256 i; i < ids.length; ++i) {
            if (_bookIndex[ids[i]] == 0) continue;
            Quote storage q = _quotes[ids[i]];
            if (q.maker != msg.sender) revert NotMaker();
            if (block.timestamp >= _series[q.seriesId].expiry) continue;
            if (sizes[i] == 0) {
                _cancel(q, ids[i]); // cancels always work, even while paused
            } else {
                if (paused) revert IsPaused();
                _update(q, ids[i], prices[i], sizes[i]);
            }
        }
    }

    function cancelQuote(uint256 quoteId) external nonReentrant {
        Quote storage q = _quotes[quoteId];
        if (q.maker != msg.sender) revert NotMaker();
        if (_bookIndex[quoteId] == 0) revert BadAmount();
        _cancel(q, quoteId);
    }

    function getQuote(uint256 quoteId) external view returns (Quote memory) {
        return _quotes[quoteId];
    }

    function quoteCount() external view returns (uint256) {
        return _quotes.length;
    }

    /// @notice Every quote id a maker ever posted. Live ones have size > 0.
    function quotesOf(address maker) external view returns (uint256[] memory) {
        return _makerQuotes[maker];
    }

    function bookOf(uint256 id)
        external
        view
        returns (Quote[] memory asks, Quote[] memory bids, uint256[] memory askIds, uint256[] memory bidIds)
    {
        askIds = _asks[id];
        bidIds = _bids[id];
        asks = new Quote[](askIds.length);
        bids = new Quote[](bidIds.length);
        for (uint256 i; i < askIds.length; ++i) asks[i] = _quotes[askIds[i]];
        for (uint256 i; i < bidIds.length; ++i) bids[i] = _quotes[bidIds[i]];
    }

    /// @notice Premium to buy `amount` from the asks right now (fee included), and how much is available.
    function quoteBuy(uint256 id, uint256 amount) external view returns (uint256 premium, uint256 fillable) {
        return _walk(_asks[id], amount, false);
    }

    /// @notice Gross proceeds from selling `amount` into the bids right now (before fee).
    function quoteSell(uint256 id, uint256 amount) external view returns (uint256 proceeds, uint256 fillable) {
        return _walk(_bids[id], amount, true);
    }

    /// @notice Market buy against the asks, best price first, then oldest quote.
    function buy(uint256 id, uint256 amount, uint256 maxPremium, address to)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 paid)
    {
        Series storage s = _seriesLive(id);
        if (amount == 0 || to == address(0)) revert BadAmount();
        uint256 left = amount;
        uint256[] storage book = _asks[id];
        while (left > 0) {
            if (book.length == 0) revert InsufficientLiquidity();
            uint256 qid = book[_best(book, false)];
            Quote storage q = _quotes[qid];
            address maker = q.maker;
            uint256 price = q.price;
            uint256 take = left < q.size ? left : q.size;
            uint256 premium = Math.mulDiv(take, price, 1e18, Math.Rounding.Ceil);
            paid += premium;
            _payPremium(msg.sender, maker, premium);

            uint256 used = take == q.size ? q.reserved : _collateralPart(s, take, q.reserved);
            q.reserved -= used;
            q.size -= uint128(take);
            _addToPool(s, used);
            written[id][maker] += take;
            s.totalWritten += take;
            left -= take;
            emit Filled(id, maker, to, take, price, qid);
            if (q.size == 0) {
                _release(q);
                _removeFromBook(q, qid);
            }
            _hook(maker, id, take, price);
        }
        if (paid > maxPremium) revert Slippage();
        s.token.mint(to, amount);
    }

    /// @notice Market sell into the bids. open=false sells options you hold (always allowed, even paused).
    /// open=true writes new options against your free collateral and sells them (sell to open).
    /// @return net USDC received after the protocol fee
    function sell(uint256 id, uint256 amount, uint256 minNet, bool open) external nonReentrant returns (uint256 net) {
        Series storage s = _seriesLive(id);
        if (amount == 0) revert BadAmount();
        if (open) {
            if (paused) revert IsPaused();
            (address t, uint256 need) = collateralFor(id, amount);
            _take(msg.sender, t, need);
            _addToPool(s, need);
            written[id][msg.sender] += amount;
            s.totalWritten += amount;
        } else {
            s.token.burn(msg.sender, amount);
        }

        uint256 gross;
        uint256 left = amount;
        uint256[] storage book = _bids[id];
        while (left > 0) {
            if (book.length == 0) revert InsufficientLiquidity();
            uint256 qid = book[_best(book, true)];
            Quote storage q = _quotes[qid];
            uint256 take = left < q.size ? left : q.size;
            uint256 pay = Math.mulDiv(take, q.price, 1e18);
            if (pay > q.reserved) pay = q.reserved;
            q.reserved -= pay;
            q.size -= uint128(take);
            gross += pay;
            left -= take;
            s.token.mint(q.maker, take);
            emit Filled(id, msg.sender, q.maker, take, q.price, qid);
            if (q.size == 0) {
                _release(q);
                _removeFromBook(q, qid);
            }
        }
        uint256 fee = Math.mulDiv(gross, feeBps, 10_000);
        net = gross - fee;
        if (net < minNet) revert Slippage();
        if (fee > 0) usdc.safeTransfer(treasury, fee);
        usdc.safeTransfer(msg.sender, net);
    }

    // ---------------------------------------------------------------- RFQ

    function rfqHash(RFQ calldata r) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(RFQ_TYPEHASH, r.maker, r.seriesId, r.price, r.maxSize, r.nonce, r.deadline)));
    }

    /// @notice Fill a maker's signed offer to write. Collateral comes from the maker's free balance.
    /// Works with EOAs and ERC-1271 smart accounts, so passkey wallets and vaults can make markets.
    function fillRFQ(RFQ calldata r, bytes calldata signature, uint256 amount, address to)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 premium)
    {
        Series storage s = _seriesLive(r.seriesId);
        if (block.timestamp > r.deadline || rfqCancelled[r.maker][r.nonce]) revert Expired();
        if (to == address(0)) revert BadAmount();
        bytes32 h = rfqHash(r);
        if (!SignatureChecker.isValidSignatureNow(r.maker, h, signature)) revert BadSignature();
        if (amount == 0 || rfqFilled[h] + amount > r.maxSize) revert BadAmount();
        rfqFilled[h] += amount;

        (address t, uint256 need) = collateralFor(r.seriesId, amount);
        _take(r.maker, t, need);
        _addToPool(s, need);
        written[r.seriesId][r.maker] += amount;
        s.totalWritten += amount;

        premium = Math.mulDiv(amount, r.price, 1e18, Math.Rounding.Ceil);
        _payPremium(msg.sender, r.maker, premium);
        s.token.mint(to, amount);
        emit RFQFilled(r.seriesId, r.maker, to, amount, r.price, h);
        _hook(r.maker, r.seriesId, amount, r.price);
    }

    function cancelRFQ(uint256 nonce) external {
        rfqCancelled[msg.sender][nonce] = true;
        emit RFQCancelled(msg.sender, nonce);
    }

    // ---------------------------------------------------------------- exercise and close

    /// @notice Physical exercise of CALL and PUT, any time before expiry. No oracle involved. Never paused.
    function exercise(uint256 id, uint256 amount) external nonReentrant {
        Series storage s = _seriesLive(id);
        if (s.kind != Kind.CALL && s.kind != Kind.PUT) revert NotExercisable();
        if (amount == 0) revert BadAmount();
        s.token.burn(msg.sender, amount);
        if (s.kind == Kind.CALL) {
            uint256 pay = Math.mulDiv(amount, s.strike, 1e18, Math.Rounding.Ceil);
            if (_pull(address(usdc), msg.sender, pay) != pay) revert TransferShortfall();
            s.poolCash += pay;
            s.poolUnderlying -= amount;
            IERC20(s.underlying).safeTransfer(msg.sender, amount);
        } else {
            uint256 get = Math.mulDiv(amount, s.strike, 1e18);
            if (_pull(s.underlying, msg.sender, amount) != amount) revert TransferShortfall();
            s.poolUnderlying += amount;
            s.poolCash -= get;
            usdc.safeTransfer(msg.sender, get);
        }
        emit Exercised(id, msg.sender, amount);
    }

    /// @notice A writer holding options of their own series burns them to unlock collateral early.
    function close(uint256 id, uint256 amount) external nonReentrant {
        Series storage s = _seriesLive(id);
        if (amount == 0 || written[id][msg.sender] < amount) revert BadAmount();
        s.token.burn(msg.sender, amount);
        uint256 outU = Math.mulDiv(s.poolUnderlying, amount, s.totalWritten);
        uint256 outC = Math.mulDiv(s.poolCash, amount, s.totalWritten);
        written[id][msg.sender] -= amount;
        s.totalWritten -= amount;
        s.poolUnderlying -= outU;
        s.poolCash -= outC;
        freeBalance[msg.sender][s.underlying] += outU;
        freeBalance[msg.sender][address(usdc)] += outC;
        emit Closed(id, msg.sender, amount);
    }

    // ---------------------------------------------------------------- settlement

    /// @notice After expiry, fix the payout for options nobody exercised, using the time-weighted price.
    /// If no settlement price arrives within the grace period, the oracle's latest spot is used when it
    /// was published after expiry; failing that, unexercised options settle worthless.
    function settle(uint256 id) external nonReentrant {
        _settle(id);
    }

    function redeem(uint256 id, uint256 amount) external nonReentrant returns (uint256, uint256) {
        return _redeem(id, msg.sender, amount);
    }

    /// @notice Permissionless payout to a holder after expiry. Keepers use it so nobody has to click Collect.
    function redeemFor(uint256 id, address holder) external nonReentrant returns (uint256, uint256) {
        uint256 bal = _series[id].token.balanceOf(holder);
        if (bal == 0) return (0, 0);
        return _redeem(id, holder, bal);
    }

    function claim(uint256 id) external nonReentrant returns (uint256, uint256) {
        return _claim(id, msg.sender);
    }

    /// @notice Permissionless: credits a writer's pro-rata share to their free balance.
    function claimFor(uint256 id, address writer) external nonReentrant returns (uint256, uint256) {
        return _claim(id, writer);
    }

    // ---------------------------------------------------------------- internals: settlement

    function _settle(uint256 id) internal {
        if (id >= _series.length) revert BadSeries();
        Series storage s = _series[id];
        if (block.timestamp < s.expiry) revert NotExpired();
        if (s.settled) revert AlreadySettled();
        (uint256 p, bool ok) = oracle.settlementPrice(s.underlying, s.expiry);
        if (!ok) {
            if (block.timestamp < s.expiry + SETTLEMENT_GRACE) revert OracleNotReady();
            (uint256 sp, uint256 at) = oracle.spot(s.underlying);
            p = at >= s.expiry ? sp : 0;
        }

        uint256 supply = s.token.totalSupply();
        uint256 hU;
        uint256 hC;
        if (p > 0) {
            if (s.kind == Kind.CALL) {
                if (p > s.strike) hU = Math.mulDiv(supply, p - s.strike, p);
            } else {
                hC = Math.mulDiv(supply, _payoffCash(s, p), 1e18);
            }
        }
        if (hU > s.poolUnderlying) hU = s.poolUnderlying;
        if (hC > s.poolCash) hC = s.poolCash;

        s.settled = true;
        s.settlePrice = p;
        s.supplyAtSettle = supply;
        s.holderUnderlying = hU;
        s.holderCash = hC;
        s.writerUnderlying = s.poolUnderlying - hU;
        s.writerCash = s.poolCash - hC;
        s.writtenAtSettle = s.totalWritten;
        emit Settled(id, p, hU, hC);
    }

    function _redeem(uint256 id, address holder, uint256 amount) internal returns (uint256 outU, uint256 outC) {
        Series storage s = _series[id];
        if (!s.settled) _settle(id);
        if (amount == 0) revert BadAmount();
        s.token.burn(holder, amount);
        outU = Math.mulDiv(s.holderUnderlying, amount, s.supplyAtSettle);
        outC = Math.mulDiv(s.holderCash, amount, s.supplyAtSettle);
        if (outU > 0) IERC20(s.underlying).safeTransfer(holder, outU);
        if (outC > 0) usdc.safeTransfer(holder, outC);
        emit Redeemed(id, holder, amount, outU, outC);
    }

    function _claim(uint256 id, address writer) internal returns (uint256 outU, uint256 outC) {
        Series storage s = _series[id];
        if (!s.settled) _settle(id);
        uint256 w = written[id][writer];
        if (w == 0) return (0, 0);
        written[id][writer] = 0;
        outU = Math.mulDiv(s.writerUnderlying, w, s.writtenAtSettle);
        outC = Math.mulDiv(s.writerCash, w, s.writtenAtSettle);
        freeBalance[writer][s.underlying] += outU;
        freeBalance[writer][address(usdc)] += outC;
        emit WriterClaimed(id, writer, outU, outC);
    }

    // ---------------------------------------------------------------- internals: book

    function _post(uint256 id, bool isBid, uint128 price, uint128 size) internal returns (uint256 quoteId) {
        _seriesLive(id);
        if (size < MIN_QUOTE_SIZE || price == 0) revert BadAmount();
        uint256[] storage book = isBid ? _bids[id] : _asks[id];
        quoteId = _quotes.length;
        if (book.length >= MAX_QUOTES_PER_SIDE) {
            // Full side: a strictly better price evicts the worst quote, so spam can't lock out real makers.
            uint256 wi = _worst(book, isBid);
            uint256 worstId = book[wi];
            Quote storage w = _quotes[worstId];
            if (isBid ? price <= w.price : price >= w.price) revert BookFull();
            _release(w);
            _removeFromBook(w, worstId);
            emit QuoteEvicted(worstId, quoteId);
        }
        (address t, uint256 need) = _reserveFor(id, isBid, price, size);
        _take(msg.sender, t, need);
        _quotes.push(Quote(msg.sender, uint64(id), isBid, price, size, need));
        book.push(quoteId);
        _bookIndex[quoteId] = book.length;
        _makerQuotes[msg.sender].push(quoteId);
        emit QuotePosted(quoteId, id, msg.sender, isBid, price, size);
    }

    function _update(Quote storage q, uint256 quoteId, uint128 price, uint128 size) internal {
        if (price == 0 || size < MIN_QUOTE_SIZE) revert BadAmount();
        (address t, uint256 need) = _reserveFor(q.seriesId, q.isBid, price, size);
        if (need > q.reserved) _take(q.maker, t, need - q.reserved);
        else if (need < q.reserved) freeBalance[q.maker][t] += q.reserved - need;
        q.reserved = need;
        q.price = price;
        q.size = size;
        emit QuoteUpdated(quoteId, price, size);
    }

    function _cancel(Quote storage q, uint256 quoteId) internal {
        _release(q);
        _removeFromBook(q, quoteId);
        emit QuoteCancelled(quoteId);
    }

    function _reserveFor(uint256 id, bool isBid, uint256 price, uint256 size) internal view returns (address, uint256) {
        if (isBid) return (address(usdc), Math.mulDiv(size, price, 1e18, Math.Rounding.Ceil));
        return collateralFor(id, size);
    }

    function _release(Quote storage q) internal {
        if (q.reserved > 0) {
            address t = q.isBid ? address(usdc) : _collateralToken(q.seriesId);
            freeBalance[q.maker][t] += q.reserved;
            q.reserved = 0;
        }
        q.size = 0;
    }

    /// @dev Maker hooks run with a fixed gas budget and can never revert a fill. The caller must
    /// forward enough gas for the full budget, so a taker can't starve the maker's hedge on purpose.
    function _hook(address maker, uint256 id, uint256 amount, uint256 price) internal {
        if (!fillHook[maker] || maker.code.length == 0) return;
        uint256 g = hookGas;
        if (gasleft() < (g * 64) / 63 + 20_000) revert LowGas();
        try IFillHook(maker).onFill{gas: g}(id, amount, price) {}
        catch {
            emit HookFailed(maker, id);
        }
    }

    // ---------------------------------------------------------------- internals: helpers

    function _pull(address token, address from, uint256 amount) internal returns (uint256 got) {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(from, address(this), amount);
        got = IERC20(token).balanceOf(address(this)) - before;
    }

    function _collateralToken(uint256 id) internal view returns (address) {
        Series storage s = _series[id];
        return s.kind == Kind.CALL ? s.underlying : address(usdc);
    }

    function _cashPerOption(Series storage s) internal view returns (uint256) {
        if (s.kind == Kind.PUT) return s.strike;
        if (s.kind == Kind.CALL_SPREAD) return s.strike2 - s.strike;
        if (s.kind == Kind.PUT_SPREAD) return s.strike - s.strike2;
        return 0;
    }

    function _payoffCash(Series storage s, uint256 p) internal view returns (uint256) {
        if (s.kind == Kind.PUT) return s.strike > p ? s.strike - p : 0;
        if (s.kind == Kind.CALL_SPREAD) {
            if (p <= s.strike) return 0;
            return Math.min(p - s.strike, s.strike2 - s.strike);
        }
        if (s.kind == Kind.PUT_SPREAD) {
            if (p >= s.strike) return 0;
            return Math.min(s.strike - p, s.strike - s.strike2);
        }
        return 0;
    }

    function _seriesLive(uint256 id) internal view returns (Series storage s) {
        if (id >= _series.length) revert BadSeries();
        s = _series[id];
        if (block.timestamp >= s.expiry) revert Expired();
    }

    function _take(address user, address token, uint256 amount) internal {
        if (freeBalance[user][token] < amount) revert InsufficientBalance();
        freeBalance[user][token] -= amount;
    }

    function _addToPool(Series storage s, uint256 amount) internal {
        if (s.kind == Kind.CALL) s.poolUnderlying += amount;
        else s.poolCash += amount;
    }

    function _collateralPart(Series storage s, uint256 take, uint256 reserved) internal view returns (uint256) {
        if (s.kind == Kind.CALL) return take;
        uint256 part = Math.mulDiv(take, _cashPerOption(s), 1e18, Math.Rounding.Ceil);
        return part > reserved ? reserved : part;
    }

    function _payPremium(address from, address maker, uint256 premium) internal {
        uint256 fee = Math.mulDiv(premium, feeBps, 10_000);
        if (fee > 0) usdc.safeTransferFrom(from, treasury, fee);
        usdc.safeTransferFrom(from, maker, premium - fee);
    }

    /// @dev best = lowest ask or highest bid; ties go to the oldest quote
    function _best(uint256[] storage ids, bool isBid) internal view returns (uint256 bi) {
        uint256 bp = _quotes[ids[0]].price;
        for (uint256 i = 1; i < ids.length; ++i) {
            uint256 p = _quotes[ids[i]].price;
            if ((isBid ? p > bp : p < bp) || (p == bp && ids[i] < ids[bi])) {
                bp = p;
                bi = i;
            }
        }
    }

    /// @dev worst = highest ask or lowest bid; ties go to the newest quote
    function _worst(uint256[] storage ids, bool isBid) internal view returns (uint256 wi) {
        uint256 wp = _quotes[ids[0]].price;
        for (uint256 i = 1; i < ids.length; ++i) {
            uint256 p = _quotes[ids[i]].price;
            if ((isBid ? p < wp : p > wp) || (p == wp && ids[i] > ids[wi])) {
                wp = p;
                wi = i;
            }
        }
    }

    function _walk(uint256[] storage book, uint256 amount, bool isBid) internal view returns (uint256 total, uint256 fillable) {
        uint256[] memory ids = book;
        bool[] memory used = new bool[](ids.length);
        uint256 left = amount;
        while (left > 0) {
            bool found;
            uint256 bi;
            uint256 bp;
            for (uint256 i; i < ids.length; ++i) {
                if (used[i]) continue;
                uint256 p = _quotes[ids[i]].price;
                if (!found || (isBid ? p > bp : p < bp) || (p == bp && ids[i] < ids[bi])) {
                    found = true;
                    bi = i;
                    bp = p;
                }
            }
            if (!found) break;
            used[bi] = true;
            Quote storage q = _quotes[ids[bi]];
            uint256 take = left < q.size ? left : q.size;
            total += Math.mulDiv(take, q.price, 1e18, isBid ? Math.Rounding.Floor : Math.Rounding.Ceil);
            fillable += take;
            left -= take;
        }
    }

    function _removeFromBook(Quote storage q, uint256 quoteId) internal {
        uint256[] storage ids = q.isBid ? _bids[q.seriesId] : _asks[q.seriesId];
        uint256 idx = _bookIndex[quoteId] - 1;
        uint256 last = ids[ids.length - 1];
        ids[idx] = last;
        _bookIndex[last] = idx + 1;
        ids.pop();
        _bookIndex[quoteId] = 0;
    }

    function _tag(Kind k) internal pure returns (string memory) {
        if (k == Kind.CALL) return "UP";
        if (k == Kind.PUT) return "FLOOR";
        if (k == Kind.CALL_SPREAD) return "CAPUP";
        return "BFLOOR";
    }

    function _u(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) ++len;
        bytes memory b = new bytes(len);
        while (v != 0) {
            b[--len] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(b);
    }
}
