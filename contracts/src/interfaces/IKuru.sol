// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Kuru AccountCore (Monad testnet, Nov 2026). Trading draws on AccountCore balances, not wallets.
/// Shapes confirmed on a fork: deposit(owner, token, amount); depositing to a new owner creates its root account.
interface IKuruAccountCore {
    function deposit(address owner, address token, uint256 amount) external;
    function withdraw(uint40 rootId, address token, uint256 amount, address recipient) external;
    function rootAccountIdOf(address owner) external view returns (uint40);
    function getBalance(uint40 accountId, address token) external view returns (uint256);
}

/// Kuru spot OrderBook, one per market (base/USDC). `swap` is an exact-input taker order against the book,
/// paid from the AccountCore balance of `userId`; amounts are raw token atoms and `amountOut` is after fees.
interface IKuruMarket {
    function swap(uint40 userId, bool isBuy, uint128 amountIn, uint128 minAmountOut, uint64 deadline)
        external
        returns (uint128 amountInUsed, uint128 amountOut);
    function baseToken() external view returns (address);
    function quoteToken() external view returns (address);
    function bestBidAsk() external view returns (uint32 bid, uint32 ask);
    function pricePrecision() external view returns (uint256);
}
