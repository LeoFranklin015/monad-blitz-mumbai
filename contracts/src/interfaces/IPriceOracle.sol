// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Prices are USDC (6 decimals) per 1e18 units of the asset, i.e. per share.
interface IPriceOracle {
    /// @notice Latest reference price. Used for display, quoting and vault rules. Never for exercise.
    function spot(address asset) external view returns (uint256 price, uint256 updatedAt);

    /// @notice Time-weighted settlement price for a given expiry. ok=false until it is final.
    function settlementPrice(address asset, uint64 expiry) external view returns (uint256 price, bool ok);
}
