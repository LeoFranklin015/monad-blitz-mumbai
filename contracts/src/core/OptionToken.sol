// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice One ERC-20 per option series. 1e18 units = the right on 1 share.
/// Only the protocol can mint and burn. Holders can transfer and trade it anywhere.
contract OptionToken is ERC20 {
    address public immutable protocol;
    uint256 public immutable seriesId;

    error OnlyProtocol();

    constructor(string memory name_, string memory symbol_, uint256 seriesId_) ERC20(name_, symbol_) {
        protocol = msg.sender;
        seriesId = seriesId_;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != protocol) revert OnlyProtocol();
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        if (msg.sender != protocol) revert OnlyProtocol();
        _burn(from, amount);
    }
}
