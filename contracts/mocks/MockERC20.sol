// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test stand-in for USDC and xStocks (NVDAx, TSLAx). Same ERC-20 interface as the real tokens.
/// Real xStocks also carry a corporate-action multiplier; see README.
contract MockERC20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    /// @notice Open faucet for testnet demos.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
