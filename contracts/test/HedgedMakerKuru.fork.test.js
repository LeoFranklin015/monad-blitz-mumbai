// A buyer lifts a HedgedMaker quote and the maker hedges on Kuru's real NVDAx book in the same transaction.
// Our protocol runs on Kuru's own test tokens (USDC, NVDAx), forked from Monad testnet.
//   FORK_RPC=https://testnet-rpc.monad.xyz npx hardhat test test/HedgedMakerKuru.fork.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { KURU, forkDescribe, forkKuru, unfork } = require("./kuruFork");

const { usd, sh } = require("./fixture");
const NV = KURU.stocks.NVDAx;
const CALL_SPREAD = 2;
const PUT = 1;

forkDescribe("HedgedMaker hedging on Kuru (Monad testnet fork)", function () {
  this.timeout(600_000);
  let ctx;

  before(async () => {
    const { usdc, nvdax } = await forkKuru();
    const [owner, buyer] = await ethers.getSigners();
    const market = await ethers.getContractAt("IKuruMarket", NV.market);

    // spot from Kuru's own book, so the oracle and the hedge venue agree
    const [bid, ask] = await market.bestBidAsk();
    const mid = (Number(bid) + Number(ask)) / 2 / Number(await market.pricePrecision());
    const spot = usd(mid.toFixed(2));

    const oracle = await (await ethers.getContractFactory("SettlementOracle")).deploy(owner.address, 600);
    const protocol = await (await ethers.getContractFactory("OptionsProtocol")).deploy(KURU.usdc, await oracle.getAddress(), owner.address);
    await protocol.setUnderlying(NV.token, true);
    await oracle.pushSpot(NV.token, spot);
    // A Kuru hedge is deposit + swap + withdraw (~430k-490k gas) on top of HedgedMaker's own work, more than the
    // default 600k hook budget. The deploy script sets the same budget when Kuru is the hedge venue.
    await protocol.setHookGas(1_000_000);

    const adapter = await (await ethers.getContractFactory("KuruAdapter")).deploy(KURU.accountCore, KURU.usdc, owner.address);
    await adapter.setMarket(NV.token, NV.market);

    const hm = await (await ethers.getContractFactory("HedgedMaker")).deploy(
      await protocol.getAddress(), await adapter.getAddress(), owner.address, owner.address
    );
    await hm.setHook(true);
    const H = await hm.getAddress();
    await (await usdc.mint(H, usd(5_000))).wait();
    await (await nvdax.mint(H, sh(2))).wait();
    await hm.depositToProtocol(KURU.usdc, usd(2_000));

    const expiry = (await time.latest()) + 3 * 24 * 3600;
    const strike = Math.round(mid);
    await protocol.createSeries(NV.token, expiry, CALL_SPREAD, usd(strike), usd(strike + 20)); // id 0
    await protocol.createSeries(NV.token, expiry, PUT, usd(strike - 10), 0); // id 1
    await hm.postQuote(0n, usd("2.00"), sh(5));
    await hm.postQuote(1n, usd("2.00"), sh(5));

    await (await usdc.mint(buyer.address, usd(1_000))).wait();
    await usdc.connect(buyer).approve(await protocol.getAddress(), ethers.MaxUint256);
    console.log(`      Kuru NVDAx mid $${mid.toFixed(2)} (bid ${bid}, ask ${ask})`);
    ctx = { usdc, nvdax, protocol, hm, H, buyer, spot };
  });

  after(unfork);

  /// Logs the Kuru market emitted in a receipt (fills emit TradesPacked from the market contract).
  const kuruLogs = (rc) => rc.logs.filter((l) => l.address.toLowerCase() === NV.market.toLowerCase());

  it("buys delta in NVDAx on Kuru when a buyer lifts a call spread", async () => {
    const { protocol, hm, H, buyer, nvdax } = ctx;
    await hm.setHedges([0n], [sh("0.4")]); // short a call spread = short delta, so buy 0.4 per option
    const n0 = await nvdax.balanceOf(H);
    const tx = await protocol.connect(buyer).buy(0n, sh(2), usd(10), buyer.address);
    const rc = await tx.wait();
    await expect(tx).to.emit(hm, "Hedged");
    const got = (await nvdax.balanceOf(H)) - n0;
    expect(got).to.be.closeTo(sh("0.8"), sh("0.02")); // 2 options x 0.4, less fees and the spread
    expect(kuruLogs(rc).length).to.be.greaterThan(0); // the fill happened on Kuru's book
    console.log(`      bought ${ethers.formatEther(got)} NVDAx on Kuru inside the buyer's tx, gas ${rc.gasUsed}`);
  });

  it("sells delta in NVDAx on Kuru when a buyer lifts a Floor", async () => {
    const { protocol, hm, H, buyer, usdc } = ctx;
    await hm.setHedges([1n], [-sh("0.3")]); // short a put = long delta, so sell 0.3 per option
    const u0 = await usdc.balanceOf(H);
    const tx = await protocol.connect(buyer).buy(1n, sh(2), usd(10), buyer.address);
    const rc = await tx.wait();
    await expect(tx).to.emit(hm, "Hedged");
    expect(kuruLogs(rc).length).to.be.greaterThan(0);
    const got = (await usdc.balanceOf(H)) - u0;
    console.log(`      sold 0.6 NVDAx on Kuru for ${ethers.formatUnits(got, 6)} USDC, gas ${rc.gasUsed}`);
    expect(got).to.be.greaterThan(0n);
  });

  it("skips the hedge, and still fills the buyer, when Kuru can't meet the slippage limit", async () => {
    const { protocol, hm, buyer } = ctx;
    await hm.setMaxSlippage(0); // demand the oracle price with zero slippage: Kuru's spread and fee can't meet it
    await hm.setHedges([0n], [sh("0.4")]);
    const tx = protocol.connect(buyer).buy(0n, sh(1), usd(10), buyer.address);
    await expect(tx).to.emit(hm, "HedgeSkipped");
    await hm.setMaxSlippage(100);
  });
});
