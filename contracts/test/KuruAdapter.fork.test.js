// KuruAdapter: our IDexRouter over Kuru's spot books, tested against a fork of Monad testnet.
//   FORK_RPC=https://testnet-rpc.monad.xyz npx hardhat test test/KuruAdapter.fork.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { KURU, forkDescribe, forkKuru, unfork } = require("./kuruFork");

const { usd, sh } = require("./fixture");
const NV = KURU.stocks.NVDAx;

forkDescribe("KuruAdapter on a Monad testnet fork", function () {
  this.timeout(600_000);
  let adapter, A, usdc, nvdax, core, owner, trader, to;

  before(async () => {
    ({ usdc, nvdax, core } = await forkKuru());
    [owner, trader, to] = await ethers.getSigners();
    adapter = await (await ethers.getContractFactory("KuruAdapter")).deploy(KURU.accountCore, KURU.usdc, owner.address);
    A = await adapter.getAddress();
    await adapter.setMarket(NV.token, NV.market);
    await (await usdc.mint(trader.address, usd(1_000))).wait();
    await (await nvdax.mint(trader.address, sh(2))).wait();
    await usdc.connect(trader).approve(A, ethers.MaxUint256);
    await nvdax.connect(trader).approve(A, ethers.MaxUint256);
  });

  after(unfork);

  it("buys NVDAx with USDC on Kuru and delivers it to `to`", async () => {
    const before = await nvdax.balanceOf(to.address);
    const out = await adapter.connect(trader).swapExactIn.staticCall(KURU.usdc, NV.token, usd(100), 1n, to.address);
    await (await adapter.connect(trader).swapExactIn(KURU.usdc, NV.token, usd(100), 1n, to.address)).wait();
    const got = (await nvdax.balanceOf(to.address)) - before;
    expect(got).to.equal(out);
    // the book is near $207: 100 USDC buys roughly 0.48 NVDAx
    expect(got).to.be.within(sh("0.40"), sh("0.55"));
  });

  it("sells NVDAx for USDC on Kuru", async () => {
    const before = await usdc.balanceOf(to.address);
    await (await adapter.connect(trader).swapExactIn(NV.token, KURU.usdc, sh("0.2"), 1n, to.address)).wait();
    // 0.2 NVDAx near $207 is roughly $41
    expect((await usdc.balanceOf(to.address)) - before).to.be.within(usd(38), usd(44));
  });

  it("keeps nothing: no tokens in the adapter, no balance in its Kuru account", async () => {
    await (await adapter.connect(trader).swapExactIn(KURU.usdc, NV.token, usd(25), 1n, to.address)).wait();
    expect(await usdc.balanceOf(A)).to.equal(0n);
    expect(await nvdax.balanceOf(A)).to.equal(0n);
    const id = await core.rootAccountIdOf(A);
    expect(await core.getBalance(id, KURU.usdc)).to.equal(0n);
    expect(await core.getBalance(id, NV.token)).to.equal(0n);
  });

  it("keeps nothing after a sell either", async () => {
    await (await adapter.connect(trader).swapExactIn(NV.token, KURU.usdc, sh("0.1"), 1n, to.address)).wait();
    expect(await usdc.balanceOf(A)).to.equal(0n);
    expect(await nvdax.balanceOf(A)).to.equal(0n);
    const id = await core.rootAccountIdOf(A);
    expect(await core.getBalance(id, KURU.usdc)).to.equal(0n);
    expect(await core.getBalance(id, NV.token)).to.equal(0n);
  });

  it("returns unspent input to the caller when the order is bigger than the book", async () => {
    // the NVDAx ask side holds about $450, so 5,000 USDC can't all be spent
    await (await usdc.mint(trader.address, usd(5_000))).wait();
    const u0 = await usdc.balanceOf(trader.address);
    const n0 = await nvdax.balanceOf(to.address);
    let reverted = false;
    try {
      await (await adapter.connect(trader).swapExactIn(KURU.usdc, NV.token, usd(5_000), 1n, to.address)).wait();
    } catch {
      reverted = true; // Kuru may refuse a swap it can't fill; then nothing moved at all
    }
    const spent = u0 - (await usdc.balanceOf(trader.address));
    const got = (await nvdax.balanceOf(to.address)) - n0;
    if (reverted) {
      expect(spent).to.equal(0n);
    } else {
      expect(spent).to.be.lessThan(usd(5_000)); // the rest came back
      expect(got).to.be.greaterThan(0n);
      console.log(`      5,000 USDC offered: ${ethers.formatUnits(spent, 6)} spent for ${ethers.formatEther(got)} NVDAx, the rest refunded`);
    }
    expect(await usdc.balanceOf(A)).to.equal(0n);
    expect(await core.getBalance(await core.rootAccountIdOf(A), KURU.usdc)).to.equal(0n);
  });

  it("reverts when minOut can't be met, so the caller's try/catch sees a clean failure", async () => {
    const before = await usdc.balanceOf(trader.address);
    await expect(adapter.connect(trader).swapExactIn(KURU.usdc, NV.token, usd(10), sh(1), to.address)).to.be.reverted;
    expect(await usdc.balanceOf(trader.address)).to.equal(before);
  });

  it("rejects pairs without a market", async () => {
    const tsla = KURU.stocks.TSLAx.token; // not mapped in this test
    await expect(adapter.connect(trader).swapExactIn(KURU.usdc, tsla, usd(10), 1n, to.address)).to.be.revertedWithCustomError(adapter, "NoMarket");
    await expect(adapter.connect(trader).swapExactIn(NV.token, tsla, sh("0.1"), 1n, to.address)).to.be.revertedWithCustomError(adapter, "NoMarket");
  });

  it("only maps a stock to its own stock/USDC market, and only the owner can", async () => {
    await expect(adapter.setMarket(KURU.stocks.TSLAx.token, NV.market)).to.be.revertedWithCustomError(adapter, "WrongMarket");
    await expect(adapter.connect(trader).setMarket(NV.token, NV.market)).to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount");
  });
});
