// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice One ERC-20 per option series. 1e18 units = the right on 1 token of the underlying.
/// Only the protocol can mint and burn. Holders can transfer and trade it anywhere.
contract OptionToken is ERC20 {
    address public immutable protocol;
    uint256 public immutable seriesId;

    error OnlyProtocol();

    constructor(string memory name_, string memory symbol_, uint256 seriesId_, address protocol_) ERC20(name_, symbol_) {
        protocol = protocol_;
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

/// @notice Deploys option tokens for the protocol. Kept separate so the protocol stays under the
/// 24KB contract size limit on every EVM chain.
contract OptionTokenFactory {
    error OnlyProtocol();

    address public protocol;

    /// @notice One-time bind to the protocol that may deploy tokens.
    function bind(address protocol_) external {
        if (protocol != address(0)) revert OnlyProtocol();
        protocol = protocol_;
    }

    function deploy(string calldata name_, string calldata symbol_, uint256 seriesId_) external returns (OptionToken) {
        if (msg.sender != protocol) revert OnlyProtocol();
        return new OptionToken(name_, symbol_, seriesId_, msg.sender);
    }
}
