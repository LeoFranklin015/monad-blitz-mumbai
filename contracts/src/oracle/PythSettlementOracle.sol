// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";
import {IPyth, IMultiplierToken} from "../interfaces/IPyth.sol";

/// @title PythSettlementOracle
/// @notice Settlement oracle fed by Pyth signed updates. Permissionless: anyone can submit a Pyth
/// update inside the settlement window and it becomes a sample. No trusted reporter.
///
/// Prices are converted to USDC (6 decimals) per 1e18 underlying tokens. For wrapped xStocks, one
/// token is worth share price * multiplier, where the multiplier tracks reinvested dividends and
/// splits. Set `multiplierSource` to the contract that exposes it, or zero for 1:1 tokens.
/// Samples with a confidence interval wider than `maxConfBps` of the price are rejected.
contract PythSettlementOracle is IPriceOracle, Ownable2Step {
    struct Feed {
        bytes32 priceId;
        address multiplierSource;
        uint64 maxStaleness; // for spot(); 0 = no limit
        uint16 maxConfBps; // 0 = no limit
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

    event FeedSet(address indexed asset, bytes32 priceId, address multiplierSource, uint64 maxStaleness, uint16 maxConfBps);
    event WindowSet(uint64 window);
    event Sample(address indexed asset, uint64 indexed expiry, uint256 price, uint256 publishTime);

    error NoFeed();
    error OutsideWindow();
    error StaleOrDuplicate();
    error LowConfidence();
    error BadPrice();

    constructor(IPyth pyth_, address owner_, uint64 window_) Ownable(owner_) {
        pyth = pyth_;
        window = window_;
    }

    function setFeed(address asset, bytes32 priceId, address multiplierSource, uint64 maxStaleness, uint16 maxConfBps)
        external
        onlyOwner
    {
        feeds[asset] = Feed(priceId, multiplierSource, maxStaleness, maxConfBps);
        emit FeedSet(asset, priceId, multiplierSource, maxStaleness, maxConfBps);
    }

    function setWindow(uint64 w) external onlyOwner {
        window = w;
        emit WindowSet(w);
    }

    /// @notice Push Pyth updates and record a settlement sample. Anyone can call; excess fee is refunded.
    function recordSample(address asset, uint64 expiry, bytes[] calldata updateData) external payable {
        Feed memory f = feeds[asset];
        if (f.priceId == bytes32(0)) revert NoFeed();
        uint256 fee = pyth.getUpdateFee(updateData);
        pyth.updatePriceFeeds{value: fee}(updateData);
        IPyth.Price memory p = pyth.getPriceUnsafe(f.priceId);
        if (p.publishTime < expiry || p.publishTime > expiry + window) revert OutsideWindow();
        if (p.price <= 0) revert BadPrice();
        if (f.maxConfBps != 0 && uint256(p.conf) * 10_000 > uint256(uint64(p.price)) * f.maxConfBps) revert LowConfidence();
        Acc storage a = _acc[asset][expiry];
        if (p.publishTime <= a.lastPublish) revert StaleOrDuplicate();
        uint256 px = _toTokenPrice(f, p);
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
        return (_toTokenPrice(f, p), p.publishTime);
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

    function _toTokenPrice(Feed memory f, IPyth.Price memory p) internal view returns (uint256 px) {
        if (p.price <= 0) return 0;
        uint256 raw = uint256(uint64(p.price));
        int32 e = p.expo + 6; // to 6 decimals
        if (e >= 0) px = raw * (10 ** uint32(e));
        else px = raw / (10 ** uint32(-e));
        if (f.multiplierSource != address(0)) px = px * IMultiplierToken(f.multiplierSource).multiplier() / 1e18;
    }
}
