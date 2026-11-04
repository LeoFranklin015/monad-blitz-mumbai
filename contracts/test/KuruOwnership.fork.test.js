// Can a smart contract own a Kuru account and trade from it? Runs against a fork of Monad testnet.
//   FORK_RPC=https://testnet-rpc.monad.xyz npx hardhat test test/KuruOwnership.fork.test.js
// Skipped when FORK_RPC is unset, so `npm test` stays offline.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { KURU, forkDescribe, forkKuru, unfork } = require("./kuruFork");
const { usd, sh } = require("./fixture");

const AC = KURU.accountCore;
const USDC = KURU.usdc;
const NVDAX = KURU.stocks.NVDAx.token;
const MARKET = KURU.stocks.NVDAx.market;

forkDescribe("Kuru on Monad testnet fork: contract-owned account", function () {
  this.timeout(600_000);
  let probe, usdc, nvdax, me, recipient, coreRead;

  before(async () => {
    ({ usdc, nvdax } = await forkKuru());
    [me, recipient] = await ethers.getSigners();

    probe = await (await ethers.getContractFactory("KuruAccountProbe")).deploy(AC);
    const probeAddr = await probe.getAddress();
    expect(await ethers.provider.getCode(probeAddr)).to.not.equal("0x"); // it really is a contract
    await (await usdc.mint(probeAddr, usd(1_000))).wait();
    await (await nvdax.mint(probeAddr, sh(2))).wait();
    await (await usdc.mint(me.address, usd(1_000))).wait();

    coreRead = new ethers.Contract(AC, ["function getBalance(uint40,address) view returns (uint256)"], ethers.provider);
  });

  after(unfork);

  it("opens a Kuru root account owned by the contract", async () => {
    expect(await probe.rootId()).to.equal(0n);
    await (await probe.deposit(USDC, usd(500))).wait();
    const id = await probe.rootId();
    expect(id).to.be.greaterThan(0n);
    expect(await coreRead.getBalance(id, USDC)).to.equal(usd(500));
    console.log(`      root account id ${id}, USDC balance ${ethers.formatUnits(await coreRead.getBalance(id, USDC), 6)}`);
  });

  it("market-buys NVDAx with USDC from its own account", async () => {
    const out = await probe.swap.staticCall(MARKET, true, usd(100), 1n);
    const tx = await (await probe.swap(MARKET, true, usd(100), 1n)).wait();
    const [used, got] = out;
    expect(got).to.be.greaterThan(0n);
    const px = Number(ethers.formatUnits(used, 6)) / Number(ethers.formatEther(got));
    console.log(`      spent ${ethers.formatUnits(used, 6)} USDC for ${ethers.formatEther(got)} NVDAx (~$${px.toFixed(2)}), gas ${tx.gasUsed}`);
    expect(await coreRead.getBalance(await probe.rootId(), NVDAX)).to.equal(got);
  });

  it("market-sells NVDAx for USDC from its own account", async () => {
    await (await probe.deposit(NVDAX, sh(1))).wait();
    const [used, got] = await probe.swap.staticCall(MARKET, false, sh("0.2"), 1n);
    await (await probe.swap(MARKET, false, sh("0.2"), 1n)).wait();
    expect(got).to.be.greaterThan(0n);
    console.log(`      sold ${ethers.formatEther(used)} NVDAx for ${ethers.formatUnits(got, 6)} USDC`);
  });

  it("withdraws from its account to an external recipient", async () => {
    const id = await probe.rootId();
    const before = await usdc.balanceOf(recipient.address);
    const bal = await coreRead.getBalance(id, USDC);
    await (await probe.withdraw(USDC, bal, recipient.address)).wait();
    expect(await usdc.balanceOf(recipient.address)).to.equal(before + bal);
    expect(await coreRead.getBalance(id, USDC)).to.equal(0n);
  });

  it("hedges in one transaction (deposit, swap, withdraw) and keeps nothing", async () => {
    const probeAddr = await probe.getAddress();
    await (await usdc.connect(me).approve(probeAddr, usd(50))).wait();
    const nvBefore = await nvdax.balanceOf(recipient.address);
    const keptBefore = await nvdax.balanceOf(probeAddr);
    const tx = await (await probe.connect(me).hedge(MARKET, USDC, NVDAX, true, usd(50), 1n, recipient.address)).wait();
    const got = (await nvdax.balanceOf(recipient.address)) - nvBefore;
    expect(got).to.be.greaterThan(0n);
    expect(await nvdax.balanceOf(probeAddr)).to.equal(keptBefore); // nothing new stuck in the contract
    const id = await probe.rootId();
    expect(await coreRead.getBalance(id, USDC)).to.equal(0n); // nothing left in its Kuru account either
    console.log(`      50 USDC -> ${ethers.formatEther(got)} NVDAx delivered in one tx, gas ${tx.gasUsed}`);
  });

  it("reverts cleanly when minOut can't be met", async () => {
    await expect(probe.swap(MARKET, true, usd(10), sh(1))).to.be.reverted; // 10 USDC never buys 1 NVDAx
  });
});
