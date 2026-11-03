// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Implemented by maker contracts that want to act inside the same transaction as a fill,
/// for example to hedge on a spot order book. Called after the maker's side of the fill is booked.
interface IFillHook {
    /// @param seriesId series that traded
    /// @param amount options the maker just sold (wrote) to a buyer
    /// @param price premium per option, USDC per 1e18 options
    function onFill(uint256 seriesId, uint256 amount, uint256 price) external;
}
