// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OptionToken} from "./OptionToken.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";

/// @title OptionsProtocol
/// @notice Fully collateralized, physically settled options on tokenized stocks.
///  - Upside = call. Writer locks the stock token. Buyer can pay the strike and take the stock.
///  - Floor  = put.  Writer locks USDC. Buyer can hand over the stock and take the strike.
/// No margin, so nothing can ever be liquidated. Exercise never reads an oracle.
/// An oracle is read once, after expiry, only to net-settle options nobody exercised.
///
/// Three ways to trade, all onchain:
///  1. Resting quotes in a per-series order book, repriced by makers every block.
///  2. Signed RFQ quotes (EIP-712, also ERC-1271 for smart accounts and vaults), filled onchain.
///  3. Option tokens are plain ERC-20s, so they also trade on any DEX.
///
/// Units: option amounts and stock amounts are 18 decimals (1e18 = 1 share).
/// Strikes and quote prices are USDC (6 decimals) per 1e18 units.
contract OptionsProtocol is Ownable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- types

    struct Series {
        address underlying;
        uint64 expiry;
        bool isCall;
        uint256 strike;
        OptionToken token;
        // live pool backing all options of this series
        uint256 totalWritten; // writer claims, in option units
        uint256 poolUnderlying;
        uint256 poolCash;
        // set at settlement
        bool settled;
        uint256 settlePrice;
        uint256 supplyAtSettle;
        uint256 holderUnderlying; // reserved for unexercised in-the-money holders
        uint256 holderCash;
        uint256 writerUnderlying; // left for writers, pro rata
        uint256 writerCash;
        uint256 writtenAtSettle;
    }

    struct Quote {
        address maker;
        uint64 seriesId;
        uint128 price; // USDC per 1e18 options
        uint128 size; // options left
        uint256 reserved; // collateral held for this quote
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

    uint256 public constant MAX_QUOTES_PER_SERIES = 64;
    uint256 public constant SETTLEMENT_GRACE = 7 days;
    uint256 public constant MAX_FEE_BPS = 100;

    // ---------------------------------------------------------------- state

    IERC20 public immutable usdc;
    IPriceOracle public oracle;
    address public treasury;
    uint256 public feeBps = 10; // on premium

    mapping(address => bool) public allowedUnderlying;

    Series[] internal _series;
    mapping(bytes32 => uint256) public seriesIdOf; // key => id + 1

    mapping(address => mapping(address => uint256)) public freeBalance; // user => token => amount
    mapping(uint256 => mapping(address => uint256)) public written; // seriesId => writer => options

    Quote[] internal _quotes;
    mapping(uint256 => uint256[]) internal _book; // seriesId => quote ids
    mapping(uint256 => uint256) internal _bookIndex; // quoteId => index + 1

    mapping(bytes32 => uint256) public rfqFilled; // rfq hash => filled size
    mapping(address => mapping(uint256 => bool)) public rfqCancelled; // maker => nonce

    // ---------------------------------------------------------------- events

    event UnderlyingAllowed(address indexed asset, bool allowed);
    event SeriesCreated(uint256 indexed seriesId, address indexed underlying, uint64 expiry, bool isCall, uint256 strike, address token);
    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event QuotePosted(uint256 indexed quoteId, uint256 indexed seriesId, address indexed maker, uint256 price, uint256 size);
    event QuoteUpdated(uint256 indexed quoteId, uint256 price, uint256 size);
    event QuoteCancelled(uint256 indexed quoteId);
    event Filled(uint256 indexed seriesId, address indexed maker, address indexed buyer, uint256 amount, uint256 price, uint256 quoteId);
    event RFQFilled(uint256 indexed seriesId, address indexed maker, address indexed buyer, uint256 amount, uint256 price, bytes32 rfqHash);
    event RFQCancelled(address indexed maker, uint256 nonce);
    event Exercised(uint256 indexed seriesId, address indexed holder, uint256 amount);
    event Closed(uint256 indexed seriesId, address indexed writer, uint256 amount);
    event Settled(uint256 indexed seriesId, uint256 price, uint256 holderUnderlying, uint256 holderCash);
    event Redeemed(uint256 indexed seriesId, address indexed holder, uint256 amount, uint256 underlyingOut, uint256 cashOut);
    event WriterClaimed(uint256 indexed seriesId, address indexed writer, uint256 underlyingOut, uint256 cashOut);

    // ---------------------------------------------------------------- errors

    error NotAllowed();
    error BadSeries();
    error Expired();
    error NotExpired();
    error AlreadySettled();
    error NotSettled();
    error OracleNotReady();
    error BookFull();
    error NotMaker();
    error InsufficientBalance();
    error InsufficientLiquidity();
    error Slippage();
    error BadSignature();
    error BadAmount();

    constructor(IERC20 usdc_, IPriceOracle oracle_, address owner_)
        Ownable(owner_)
        EIP712("WeekendOptions", "1")
    {
        usdc = usdc_;
        oracle = oracle_;
        treasury = owner_;
    }

    // ---------------------------------------------------------------- admin

    function setUnderlying(address asset, bool allowed) external onlyOwner {
        allowedUnderlying[asset] = allowed;
        emit UnderlyingAllowed(asset, allowed);
    }

    function setOracle(IPriceOracle oracle_) external onlyOwner {
        oracle = oracle_;
    }

    function setFee(uint256 feeBps_, address treasury_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert BadAmount();
        feeBps = feeBps_;
        treasury = treasury_;
    }

    // ---------------------------------------------------------------- series

    /// @notice Permissionless. Anyone can open a series on an allowed stock token.
    function createSeries(address underlying, uint64 expiry, bool isCall, uint256 strike) external returns (uint256 id) {
        if (!allowedUnderlying[underlying]) revert NotAllowed();
        if (expiry <= block.timestamp || strike == 0) revert BadSeries();
        bytes32 key = keccak256(abi.encode(underlying, expiry, isCall, strike));
        if (seriesIdOf[key] != 0) return seriesIdOf[key] - 1;

        id = _series.length;
        string memory side = isCall ? "UP" : "FLOOR";
        OptionToken token = new OptionToken(
            string.concat("Weekend ", side, " #", _u(id)),
            string.concat(side, "-", _u(id)),
            id
        );
        Series storage s = _series.push();
        s.underlying = underlying;
        s.expiry = expiry;
        s.isCall = isCall;
        s.strike = strike;
        s.token = token;
        seriesIdOf[key] = id + 1;
        emit SeriesCreated(id, underlying, expiry, isCall, strike, address(token));
    }

    function seriesCount() external view returns (uint256) {
        return _series.length;
    }

    function getSeries(uint256 id) external view returns (Series memory) {
        return _series[id];
    }

    /// @notice Token a writer must lock for a series, and how much for `amount` options.
    function collateralFor(uint256 id, uint256 amount) public view returns (address token, uint256 need) {
        Series storage s = _series[id];
        if (s.isCall) return (s.underlying, amount);
        return (address(usdc), Math.mulDiv(amount, s.strike, 1e18, Math.Rounding.Ceil));
    }

    // ---------------------------------------------------------------- balances

    function deposit(address token, uint256 amount) external nonReentrant {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        freeBalance[msg.sender][token] += amount;
        emit Deposited(msg.sender, token, amount);
    }

    function withdraw(address token, uint256 amount) external nonReentrant {
        if (freeBalance[msg.sender][token] < amount) revert InsufficientBalance();
        freeBalance[msg.sender][token] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, token, amount);
    }

    // ---------------------------------------------------------------- order book

    /// @notice Post an ask. Collateral moves from free balance into the quote, so a quote is always fully backed.
    function postQuote(uint256 id, uint128 price, uint128 size) public returns (uint256 quoteId) {
        _seriesLive(id);
        if (size == 0 || price == 0) revert BadAmount();
        if (_book[id].length >= MAX_QUOTES_PER_SERIES) revert BookFull();
        (address ctoken, uint256 need) = collateralFor(id, size);
        _take(msg.sender, ctoken, need);

        quoteId = _quotes.length;
        _quotes.push(Quote(msg.sender, uint64(id), price, size, need));
        _book[id].push(quoteId);
        _bookIndex[quoteId] = _book[id].length;
        emit QuotePosted(quoteId, id, msg.sender, price, size);
    }

    /// @notice Reprice and resize in one call. This is what maker bots do every block.
    function updateQuote(uint256 quoteId, uint128 price, uint128 size) public {
        Quote storage q = _quotes[quoteId];
        if (q.maker != msg.sender) revert NotMaker();
        if (_bookIndex[quoteId] == 0) revert BadAmount();
        if (size == 0) return cancelQuote(quoteId);
        _seriesLive(q.seriesId);
        if (price == 0) revert BadAmount();
        (address ctoken, uint256 need) = collateralFor(q.seriesId, size);
        if (need > q.reserved) _take(msg.sender, ctoken, need - q.reserved);
        else if (need < q.reserved) freeBalance[msg.sender][ctoken] += q.reserved - need;
        q.reserved = need;
        q.price = price;
        q.size = size;
        emit QuoteUpdated(quoteId, price, size);
    }

    function updateQuotes(uint256[] calldata ids, uint128[] calldata prices, uint128[] calldata sizes) external {
        if (ids.length != prices.length || ids.length != sizes.length) revert BadAmount();
        for (uint256 i; i < ids.length; ++i) updateQuote(ids[i], prices[i], sizes[i]);
    }

    function cancelQuote(uint256 quoteId) public {
        Quote storage q = _quotes[quoteId];
        if (q.maker != msg.sender) revert NotMaker();
        if (_bookIndex[quoteId] == 0) revert BadAmount();
        (address ctoken,) = collateralFor(q.seriesId, 0);
        freeBalance[msg.sender][ctoken] += q.reserved;
        q.reserved = 0;
        q.size = 0;
        _removeFromBook(q.seriesId, quoteId);
        emit QuoteCancelled(quoteId);
    }

    function getQuote(uint256 quoteId) external view returns (Quote memory) {
        return _quotes[quoteId];
    }

    function bookOf(uint256 id) external view returns (Quote[] memory qs, uint256[] memory ids) {
        ids = _book[id];
        qs = new Quote[](ids.length);
        for (uint256 i; i < ids.length; ++i) qs[i] = _quotes[ids[i]];
    }

    /// @notice Best ask and the premium to buy `amount` right now.
    function quoteBuy(uint256 id, uint256 amount) external view returns (uint256 premium, uint256 fillable) {
        uint256[] memory ids = _book[id];
        bool[] memory used = new bool[](ids.length);
        uint256 left = amount;
        while (left > 0) {
            (uint256 bi, bool found) = _bestIn(ids, used);
            if (!found) break;
            used[bi] = true;
            Quote storage q = _quotes[ids[bi]];
            uint256 take = left < q.size ? left : q.size;
            premium += Math.mulDiv(take, q.price, 1e18, Math.Rounding.Ceil);
            fillable += take;
            left -= take;
        }
    }

    /// @notice Market buy against the book, best price first, then oldest quote.
    /// @param to who receives the option tokens (lets vaults and other contracts buy for users)
    function buy(uint256 id, uint256 amount, uint256 maxPremium, address to)
        external
        nonReentrant
        returns (uint256 premiumPaid)
    {
        Series storage s = _seriesLive(id);
        if (amount == 0) revert BadAmount();
        uint256 left = amount;
        uint256[] storage ids = _book[id];

        while (left > 0) {
            if (ids.length == 0) revert InsufficientLiquidity();
            uint256 best = _best(ids);
            uint256 quoteId = ids[best];
            Quote storage q = _quotes[quoteId];
            uint256 take = left < q.size ? left : q.size;

            uint256 premium = Math.mulDiv(take, q.price, 1e18, Math.Rounding.Ceil);
            premiumPaid += premium;
            _payPremium(msg.sender, q.maker, premium);

            uint256 used = take == q.size ? q.reserved : _collateralPart(s, take, q.reserved, q.size);
            q.reserved -= used;
            q.size -= uint128(take);
            _addToPool(s, used);
            written[id][q.maker] += take;
            s.totalWritten += take;
            left -= take;
            emit Filled(id, q.maker, to, take, q.price, quoteId);

            if (q.size == 0) {
                if (q.reserved > 0) {
                    (address ctoken,) = collateralFor(id, 0);
                    freeBalance[q.maker][ctoken] += q.reserved;
                    q.reserved = 0;
                }
                _removeFromBook(id, quoteId);
            }
        }
        if (premiumPaid > maxPremium) revert Slippage();
        s.token.mint(to, amount);
    }

    // ---------------------------------------------------------------- RFQ

    function rfqHash(RFQ calldata r) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(RFQ_TYPEHASH, r.maker, r.seriesId, r.price, r.maxSize, r.nonce, r.deadline))
        );
    }

    /// @notice Fill a maker's signed quote. Collateral comes from the maker's free balance at fill time.
    /// Works with EOAs and with ERC-1271 smart accounts (passkey wallets, vaults).
    function fillRFQ(RFQ calldata r, bytes calldata signature, uint256 amount, address to)
        external
        nonReentrant
        returns (uint256 premium)
    {
        Series storage s = _seriesLive(r.seriesId);
        if (block.timestamp > r.deadline || rfqCancelled[r.maker][r.nonce]) revert Expired();
        bytes32 h = rfqHash(r);
        if (!SignatureChecker.isValidSignatureNow(r.maker, h, signature)) revert BadSignature();
        if (amount == 0 || rfqFilled[h] + amount > r.maxSize) revert BadAmount();
        rfqFilled[h] += amount;

        (address ctoken, uint256 need) = collateralFor(r.seriesId, amount);
        _take(r.maker, ctoken, need);
        _addToPool(s, need);
        written[r.seriesId][r.maker] += amount;
        s.totalWritten += amount;

        premium = Math.mulDiv(amount, r.price, 1e18, Math.Rounding.Ceil);
        _payPremium(msg.sender, r.maker, premium);
        s.token.mint(to, amount);
        emit RFQFilled(r.seriesId, r.maker, to, amount, r.price, h);
    }

    function cancelRFQ(uint256 nonce) external {
        rfqCancelled[msg.sender][nonce] = true;
        emit RFQCancelled(msg.sender, nonce);
    }

    // ---------------------------------------------------------------- exercise and close

    /// @notice Physical exercise, any time before expiry. No oracle involved.
    /// Upside: pay strike in USDC, receive the stock token.
    /// Floor: hand over the stock token, receive the strike in USDC.
    function exercise(uint256 id, uint256 amount) external nonReentrant {
        Series storage s = _seriesLive(id);
        if (amount == 0) revert BadAmount();
        s.token.burn(msg.sender, amount);
        if (s.isCall) {
            uint256 pay = Math.mulDiv(amount, s.strike, 1e18, Math.Rounding.Ceil);
            usdc.safeTransferFrom(msg.sender, address(this), pay);
            s.poolCash += pay;
            s.poolUnderlying -= amount;
            IERC20(s.underlying).safeTransfer(msg.sender, amount);
        } else {
            uint256 get = Math.mulDiv(amount, s.strike, 1e18);
            IERC20(s.underlying).safeTransferFrom(msg.sender, address(this), amount);
            s.poolUnderlying += amount;
            s.poolCash -= get;
            usdc.safeTransfer(msg.sender, get);
        }
        emit Exercised(id, msg.sender, amount);
    }

    /// @notice A writer who holds options of their own series can burn them to unlock collateral early.
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
    /// If no price arrives within the grace period, unexercised options settle as worthless,
    /// since holders always had the oracle-free route of exercising before expiry.
    function settle(uint256 id) public {
        Series storage s = _series[id];
        if (block.timestamp < s.expiry) revert NotExpired();
        if (s.settled) revert AlreadySettled();

        (uint256 p, bool ok) = oracle.settlementPrice(s.underlying, s.expiry);
        if (!ok) {
            if (block.timestamp < s.expiry + SETTLEMENT_GRACE) revert OracleNotReady();
            p = 0;
        }

        uint256 supply = s.token.totalSupply();
        uint256 hU;
        uint256 hC;
        if (p > 0) {
            if (s.isCall && p > s.strike) {
                hU = Math.mulDiv(supply, p - s.strike, p);
            } else if (!s.isCall && s.strike > p) {
                hC = Math.mulDiv(supply, s.strike - p, 1e18);
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

    /// @notice Holder side after settlement. Burns options, pays the in-the-money value.
    function redeem(uint256 id, uint256 amount) external nonReentrant returns (uint256 outU, uint256 outC) {
        Series storage s = _series[id];
        if (!s.settled) settle(id);
        if (amount == 0) revert BadAmount();
        s.token.burn(msg.sender, amount);
        outU = Math.mulDiv(s.holderUnderlying, amount, s.supplyAtSettle);
        outC = Math.mulDiv(s.holderCash, amount, s.supplyAtSettle);
        if (outU > 0) IERC20(s.underlying).safeTransfer(msg.sender, outU);
        if (outC > 0) usdc.safeTransfer(msg.sender, outC);
        emit Redeemed(id, msg.sender, amount, outU, outC);
    }

    /// @notice Writer side after settlement. Pro-rata share of what is left in the pool, credited to free balance.
    function claim(uint256 id) public returns (uint256 outU, uint256 outC) {
        Series storage s = _series[id];
        if (!s.settled) settle(id);
        uint256 w = written[id][msg.sender];
        if (w == 0) return (0, 0);
        written[id][msg.sender] = 0;
        outU = Math.mulDiv(s.writerUnderlying, w, s.writtenAtSettle);
        outC = Math.mulDiv(s.writerCash, w, s.writtenAtSettle);
        freeBalance[msg.sender][s.underlying] += outU;
        freeBalance[msg.sender][address(usdc)] += outC;
        emit WriterClaimed(id, msg.sender, outU, outC);
    }

    // ---------------------------------------------------------------- internals

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
        if (s.isCall) s.poolUnderlying += amount;
        else s.poolCash += amount;
    }

    function _collateralPart(Series storage s, uint256 take, uint256 reserved, uint256 size)
        internal
        view
        returns (uint256)
    {
        size;
        if (s.isCall) return take;
        uint256 part = Math.mulDiv(take, s.strike, 1e18, Math.Rounding.Ceil);
        return part > reserved ? reserved : part;
    }

    function _payPremium(address from, address maker, uint256 premium) internal {
        uint256 fee = Math.mulDiv(premium, feeBps, 10_000);
        if (fee > 0) usdc.safeTransferFrom(from, treasury, fee);
        usdc.safeTransferFrom(from, maker, premium - fee);
    }

    function _best(uint256[] storage ids) internal view returns (uint256 bi) {
        uint256 bp = type(uint256).max;
        for (uint256 i; i < ids.length; ++i) {
            uint256 p = _quotes[ids[i]].price;
            if (p < bp || (p == bp && ids[i] < ids[bi])) {
                bp = p;
                bi = i;
            }
        }
    }

    function _bestIn(uint256[] memory ids, bool[] memory used) internal view returns (uint256 bi, bool found) {
        uint256 bp = type(uint256).max;
        for (uint256 i; i < ids.length; ++i) {
            if (used[i]) continue;
            uint256 p = _quotes[ids[i]].price;
            if (!found || p < bp || (p == bp && ids[i] < ids[bi])) {
                bp = p;
                bi = i;
                found = true;
            }
        }
    }

    function _removeFromBook(uint256 id, uint256 quoteId) internal {
        uint256[] storage ids = _book[id];
        uint256 idx = _bookIndex[quoteId] - 1;
        uint256 last = ids[ids.length - 1];
        ids[idx] = last;
        _bookIndex[last] = idx + 1;
        ids.pop();
        _bookIndex[quoteId] = 0;
    }

    function _u(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) ++len;
        bytes memory b = new bytes(len);
        while (v != 0) {
            b[--len] = bytes1(uint8(48 + v % 10));
            v /= 10;
        }
        return string(b);
    }
}
