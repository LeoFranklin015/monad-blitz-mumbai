// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";
import {IPyth, IMultiplierToken} from "../interfaces/IPyth.sol";

/// @title PythSettlementOracle
/// @notice Settlement oracle fed by Pyth signed updates. Permissionless: anyone can submit a Pyth
/// update inside the settlement window and it becomes a sample. No trusted reporter.
///
/// Prices are converted to USDC (6 decimals) per 1e18 raw stock tokens. For xStocks, the raw
/// token's value is share price * multiplier, so options written on raw tokens stay correct across
/// dividends and splits: a 2:1 split halves the share price and doubles the multiplier, and the
/// per-token price this oracle reports does not jump.
contract PythSettlementOracle is IPriceOracle, Ownable {
    struct Feed {
        bytes32 priceId;
        bool useMultiplier;
        uint64 maxStaleness; // for spot()
    }

    struct Acc {
        uint256 sum;
        uint256 count;
        uint256 lastPublish;
    }

    IPyth public immutable pyth;
    uint64 public window;
    mapping(address => Feed) public feeds;
    mapping(address => mapping(uint64 => Acc)) internal _acc;

    event FeedSet(address indexed asset, bytes32 priceId, bool useMultiplier);
    event Sample(address indexed asset, uint64 indexed expiry, uint256 price, uint256 publishTime);

    error NoFeed();
    error OutsideWindow();
    error StaleOrDuplicate();

    constructor(IPyth pyth_, address owner_, uint64 window_) Ownable(owner_) {
        pyth = pyth_;
        window = window_;
    }

    function setFeed(address asset, bytes32 priceId, bool useMultiplier, uint64 maxStaleness) external onlyOwner {
        feeds[asset] = Feed(priceId, useMultiplier, maxStaleness);
        emit FeedSet(asset, priceId, useMultiplier);
    }

    function setWindow(uint64 w) external onlyOwner {
        window = w;
    }

    /// @notice Push Pyth updates and record a settlement sample. Anyone can call; excess fee is refunded.
    function recordSample(address asset, uint64 expiry, bytes[] calldata updateData) external payable {
        Feed memory f = feeds[asset];
        if (f.priceId == bytes32(0)) revert NoFeed();
        uint256 fee = pyth.getUpdateFee(updateData);
        pyth.updatePriceFeeds{value: fee}(updateData);
        IPyth.Price memory p = pyth.getPriceUnsafe(f.priceId);
        if (p.publishTime < expiry || p.publishTime > expiry + window) revert OutsideWindow();
        Acc storage a = _acc[asset][expiry];
        if (p.publishTime <= a.lastPublish) revert StaleOrDuplicate();
        uint256 px = _toTokenPrice(asset, f, p);
        a.sum += px;
        a.count += 1;
        a.lastPublish = p.publishTime;
        emit Sample(asset, expiry, px, p.publishTime);
        if (msg.value > fee) {
            (bool ok,) = msg.sender.call{value: msg.value - fee}("");
            ok;
        }
    }

    function spot(address asset) external view returns (uint256, uint256) {
        Feed memory f = feeds[asset];
        if (f.priceId == bytes32(0)) return (0, 0);
        IPyth.Price memory p = pyth.getPriceUnsafe(f.priceId);
        if (f.maxStaleness != 0 && p.publishTime + f.maxStaleness < block.timestamp) return (0, p.publishTime);
        return (_toTokenPrice(asset, f, p), p.publishTime);
    }

    function settlementPrice(address asset, uint64 expiry) external view returns (uint256, bool) {
        Acc storage a = _acc[asset][expiry];
        if (a.count == 0 || block.timestamp <= expiry + window) return (0, false);
        return (a.sum / a.count, true);
    }

    function samples(address asset, uint64 expiry) external view returns (uint256 sum, uint256 count) {
        Acc storage a = _acc[asset][expiry];
        return (a.sum, a.count);
    }

    function _toTokenPrice(address asset, Feed memory f, IPyth.Price memory p) internal view returns (uint256 px) {
        if (p.price <= 0) return 0;
        uint256 raw = uint256(uint64(p.price));
        int32 e = p.expo + 6; // to 6 decimals
        if (e >= 0) px = raw * (10 ** uint32(e));
        else px = raw / (10 ** uint32(-e));
        if (f.useMultiplier) px = px * IMultiplierToken(asset).multiplier() / 1e18;
    }
}
