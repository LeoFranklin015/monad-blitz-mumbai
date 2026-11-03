// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Subset of Pyth's onchain interface (pull oracle).
interface IPyth {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }

    function getPriceUnsafe(bytes32 id) external view returns (Price memory);
    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256);
    function updatePriceFeeds(bytes[] calldata updateData) external payable;
}

/// @notice Tokenized stocks that track corporate actions with a balance multiplier.
/// The raw token balance never changes; value per raw token = share price * multiplier / 1e18.
/// Match this selector to the issuer's contract before going live.
interface IMultiplierToken {
    function multiplier() external view returns (uint256);
}
