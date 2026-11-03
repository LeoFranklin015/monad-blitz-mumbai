// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice xStock-style token: raw balances never change on corporate actions, a multiplier does.
/// Open faucet for demos.
contract MockXStock is ERC20, Ownable {
    uint256 public multiplier = 1e18;

    event MultiplierUpdated(uint256 multiplier);

    constructor(string memory n, string memory s, address owner_) ERC20(n, s) Ownable(owner_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice e.g. a 2:1 split doubles the multiplier; a reinvested dividend nudges it up.
    function setMultiplier(uint256 m) external onlyOwner {
        multiplier = m;
        emit MultiplierUpdated(m);
    }
}
