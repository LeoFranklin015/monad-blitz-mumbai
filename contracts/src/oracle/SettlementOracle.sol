// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @title SettlementOracle
/// @notice Reporter-fed oracle with a time-weighted settlement window.
///  - spot(): latest price, for quoting and display only.
///  - settlementPrice(): average of every sample posted in [expiry, expiry + window].
///    On Monad, a 10 minute window at ~400ms blocks can hold ~1,500 samples, which makes the
///    settlement price expensive to push around compared with a single print.
/// In production, reporters relay Pyth or Chainlink updates. A Pyth adapter can implement the
/// same interface by reading the pull feed and accumulating samples the same way.
contract SettlementOracle is IPriceOracle, Ownable {
    struct Acc {
        uint256 sum;
        uint256 count;
    }

    uint64 public window;
    mapping(address => bool) public reporter;
    mapping(address => uint256) internal _spot;
    mapping(address => uint256) internal _spotAt;
    mapping(address => mapping(uint64 => Acc)) internal _acc;

    event Reporter(address indexed who, bool ok);
    event Spot(address indexed asset, uint256 price);
    event Sample(address indexed asset, uint64 indexed expiry, uint256 price);

    error NotReporter();
    error OutsideWindow();

    constructor(address owner_, uint64 window_) Ownable(owner_) {
        window = window_;
        reporter[owner_] = true;
    }

    function setReporter(address who, bool ok) external onlyOwner {
        reporter[who] = ok;
        emit Reporter(who, ok);
    }

    function setWindow(uint64 w) external onlyOwner {
        window = w;
    }

    function pushSpot(address asset, uint256 price) public {
        if (!reporter[msg.sender]) revert NotReporter();
        _spot[asset] = price;
        _spotAt[asset] = block.timestamp;
        emit Spot(asset, price);
    }

    /// @notice Record a settlement sample. Only accepted inside the window after expiry.
    function pushSample(address asset, uint64 expiry, uint256 price) external {
        if (!reporter[msg.sender]) revert NotReporter();
        if (block.timestamp < expiry || block.timestamp > expiry + window) revert OutsideWindow();
        Acc storage a = _acc[asset][expiry];
        a.sum += price;
        a.count += 1;
        pushSpot(asset, price);
        emit Sample(asset, expiry, price);
    }

    function spot(address asset) external view returns (uint256, uint256) {
        return (_spot[asset], _spotAt[asset]);
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
}
