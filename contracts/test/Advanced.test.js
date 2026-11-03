const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployAll, settleAt, usd, sh, WINDOW } = require("./fixture");

const CALL = 0, PUT = 1, CALL_SPREAD = 2, PUT_SPREAD = 3;

describe("Two-sided book: bids, sell-back, sell to open", function () {
  async function withAskAndBid(ctx) {
    const { protocol, makerA, makerB, usdc, N, callId } = ctx;
    await protocol.connect(makerB).deposit(N, sh(10));
    await protocol.connect(makerB).postQuote(callId, usd("1.70"), sh(10));
    await protocol.connect(makerA).deposit(await usdc.getAddress(), usd(100));
    await protocol.connect(makerA).postBid(callId, usd("1.50"), sh(20));
  }

  it("holder sells options back into the best bid before expiry", async function () {
    const ctx = await loadFixture(deployAll);
    await withAskAndBid(ctx);
    const { protocol, buyer, makerA, usdc, callId, tokenOf } = ctx;
    const tok = await tokenOf(callId);
    await protocol.connect(buyer).buy(callId, sh(10), usd(17), buyer.address);
    const [gross] = await protocol.quoteSell(callId, sh(10));
    expect(gross).to.equal(usd(15));
    const u0 = await usdc.balanceOf(buyer.address);
    await protocol.connect(buyer).sell(callId, sh(10), usd("14.98"), false);
    expect((await usdc.balanceOf(buyer.address)) - u0).to.equal(usd("14.985"));
    expect(await tok.balanceOf(buyer.address)).to.equal(0n);
    expect(await tok.balanceOf(makerA.address)).to.equal(sh(10));
    expect(await tok.totalSupply()).to.equal(sh(10));
  });

  it("a writer can sell to open straight into a bid", async function () {
    const ctx = await loadFixture(deployAll);
    await withAskAndBid(ctx);
    const { protocol, makerC, makerA, N, callId, tokenOf } = ctx;
    await protocol.connect(makerC).deposit(N, sh(5));
    await protocol.connect(makerC).sell(callId, sh(5), 0, true);
    expect(await protocol.written(callId, makerC.address)).to.equal(sh(5));
    expect(await (await tokenOf(callId)).balanceOf(makerA.address)).to.equal(sh(5));
    expect(await protocol.freeBalance(makerC.address, N)).to.equal(0n);
  });

  it("rejects bad fills and returns unused bid money", async function () {
    const ctx = await loadFixture(deployAll);
    await withAskAndBid(ctx);
    const { protocol, buyer, makerA, usdc, callId } = ctx;
    await protocol.connect(buyer).buy(callId, sh(10), usd(17), buyer.address);
    await expect(protocol.connect(buyer).sell(callId, sh(10), usd(16), false)).to.be.revertedWithCustomError(protocol, "Slippage");
    await expect(protocol.connect(buyer).sell(callId, sh(30), 0, true)).to.be.revertedWithCustomError(protocol, "InsufficientBalance");
    const ids = await protocol.quotesOf(makerA.address);
    await protocol.connect(makerA).cancelQuote(ids[0]);
    expect(await protocol.freeBalance(makerA.address, await usdc.getAddress())).to.equal(usd(100));
  });
});

describe("Spreads: max-loss collateral", function () {
  it("Capped Upside locks only the width, cannot be exercised, pays capped", async function () {
    const ctx = await loadFixture(deployAll);
    const { protocol, makerA, buyer, usdc, N, expiry } = ctx;
    const U = await usdc.getAddress();
    await protocol.createSeries(N, expiry, CALL_SPREAD, usd(205), usd(215));
    const id = 2n;
    const [, need] = await protocol.collateralFor(id, sh(10));
    expect(need).to.equal(usd(100)); // vs 10 NVDAx (~$2,000) for a plain Upside
    await protocol.connect(makerA).deposit(U, usd(100));
    await protocol.connect(makerA).postQuote(id, usd("1.20"), sh(10));
    await protocol.connect(buyer).buy(id, sh(10), usd(12), buyer.address);
    await expect(protocol.connect(buyer).exercise(id, sh(1))).to.be.revertedWithCustomError(protocol, "NotExercisable");

    await settleAt(ctx, [240]);
    const u0 = await usdc.balanceOf(buyer.address);
    await protocol.connect(buyer).redeem(id, sh(10));
    expect((await usdc.balanceOf(buyer.address)) - u0).to.equal(usd(100)); // capped at the width
    await protocol.connect(makerA).claim(id);
    expect(await protocol.freeBalance(makerA.address, U)).to.equal(0n);
  });

  it("Budget Floor pays between the two strikes", async function () {
    const ctx = await loadFixture(deployAll);
    const { protocol, makerA, buyer, usdc, N, expiry } = ctx;
    const U = await usdc.getAddress();
    await protocol.createSeries(N, expiry, PUT_SPREAD, usd(195), usd(180));
    const id = 2n;
    await protocol.connect(makerA).deposit(U, usd(150));
    await protocol.connect(makerA).postQuote(id, usd(1), sh(10));
    await protocol.connect(buyer).buy(id, sh(10), usd(10), buyer.address);
    await settleAt(ctx, [190]);
    const u0 = await usdc.balanceOf(buyer.address);
    await protocol.connect(buyer).redeem(id, sh(10));
    expect((await usdc.balanceOf(buyer.address)) - u0).to.equal(usd(50));
    await protocol.connect(makerA).claim(id);
    expect(await protocol.freeBalance(makerA.address, U)).to.equal(usd(100));
  });

  it("rejects malformed spreads", async function () {
    const ctx = await loadFixture(deployAll);
    const { protocol, N, expiry } = ctx;
    await expect(protocol.createSeries(N, expiry, CALL_SPREAD, usd(205), usd(200))).to.be.revertedWithCustomError(protocol, "BadSeries");
    await expect(protocol.createSeries(N, expiry, PUT_SPREAD, usd(195), usd(195))).to.be.revertedWithCustomError(protocol, "BadSeries");
    await expect(protocol.createSeries(N, expiry, CALL, usd(205), usd(1))).to.be.revertedWithCustomError(protocol, "BadSeries");
  });
});

describe("HedgedMaker: fill and hedge in one transaction", function () {
  async function setup(ctx) {
    const { protocol, oracle, usdc, nvda, owner, N, expiry } = ctx;
    const U = await usdc.getAddress();
    const dex = await (await ethers.getContractFactory("MockDex")).deploy(await oracle.getAddress(), U);
    await usdc.mint(await dex.getAddress(), usd(1_000_000));
    await nvda.mint(await dex.getAddress(), sh(10_000));
    const hm = await (await ethers.getContractFactory("HedgedMaker")).deploy(
      await protocol.getAddress(), await dex.getAddress(), owner.address, owner.address
    );
    await hm.setHook(true);
    const H = await hm.getAddress();
    await usdc.mint(H, usd(10_000));
    await hm.depositToProtocol(U, usd(200));
    await protocol.createSeries(N, expiry, CALL_SPREAD, usd(205), usd(225));
    const id = 2n;
    await hm.postQuote(id, usd("1.50"), sh(10));
    return { dex, hm, H, id, U };
  }

  it("buys delta in stock on spot inside the buyer's transaction", async function () {
    const ctx = await loadFixture(deployAll);
    const { hm, H, id } = await setup(ctx);
    const { protocol, buyer, nvda } = ctx;
    await hm.setHedges([id], [sh("0.4")]);
    await expect(protocol.connect(buyer).buy(id, sh(10), usd(15), buyer.address)).to.emit(hm, "Hedged");
    expect(await nvda.balanceOf(H)).to.be.closeTo(sh(4), sh("0.01"));
  });

  it("never blocks a buyer when the hedge cannot run", async function () {
    const ctx = await loadFixture(deployAll);
    const { hm, id } = await setup(ctx);
    const { protocol, buyer, tokenOf } = ctx;
    await hm.setHedges([id], [-sh("0.4")]); // wants to sell stock it does not hold
    await expect(protocol.connect(buyer).buy(id, sh(10), usd(15), buyer.address)).to.emit(hm, "HedgeSkipped");
    expect(await (await tokenOf(id)).balanceOf(buyer.address)).to.equal(sh(10));
  });

  it("only the protocol can call the hook", async function () {
    const ctx = await loadFixture(deployAll);
    const { hm } = await setup(ctx);
    await expect(hm.onFill(0, 1, 1)).to.be.revertedWithCustomError(hm, "NotProtocol");
  });
});

describe("Keeper paths", function () {
  it("anyone can pay out holders and credit writers after expiry", async function () {
    const ctx = await loadFixture(deployAll);
    const { protocol, makerB, buyer, other, nvda, N, callId } = ctx;
    await protocol.connect(makerB).deposit(N, sh(10));
    await protocol.connect(makerB).postQuote(callId, usd("1.70"), sh(10));
    await protocol.connect(buyer).buy(callId, sh(10), usd(17), buyer.address);
    await settleAt(ctx, [212]);
    const n0 = await nvda.balanceOf(buyer.address);
    await protocol.connect(other).redeemFor(callId, buyer.address);
    expect((await nvda.balanceOf(buyer.address)) - n0).to.be.closeTo(sh("0.330188679245283018"), 10n);
    await protocol.connect(other).claimFor(callId, makerB.address);
    expect(await protocol.freeBalance(makerB.address, N)).to.be.closeTo(sh("9.669811320754716981"), 10n);
    expect((await protocol.redeemFor.staticCall(callId, buyer.address))[0]).to.equal(0n);
  });
});

describe("Pyth oracle and xStock corporate actions", function () {
  const ID = ethers.id("NVDA/USD");
  const enc = (price, t) =>
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "int64", "uint64", "int32", "uint64"],
      [ID, BigInt(Math.round(price * 1e8)), 0n, -8, BigInt(t)]
    );

  async function setup(ctx) {
    const { protocol, owner, N } = ctx;
    const pyth = await (await ethers.getContractFactory("MockPyth")).deploy();
    const po = await (await ethers.getContractFactory("PythSettlementOracle")).deploy(await pyth.getAddress(), owner.address, WINDOW);
    await po.setFeed(N, ID, N, 0, 0);
    await protocol.setOracle(await po.getAddress());
    return { pyth, po };
  }

  it("options on raw tokens settle correctly across a 2:1 split", async function () {
    const ctx = await loadFixture(deployAll);
    const { po } = await setup(ctx);
    const { protocol, makerB, buyer, nvda, N, callId, expiry, owner } = ctx;
    await protocol.connect(makerB).deposit(N, sh(10));
    await protocol.connect(makerB).postQuote(callId, usd("1.70"), sh(10));
    await protocol.connect(buyer).buy(callId, sh(10), usd(17), buyer.address);

    // 2:1 split over the weekend: share price halves, multiplier doubles, per-token value is unchanged
    await nvda.connect(owner).setMultiplier(sh(2));
    await time.increaseTo(expiry + 5);
    await po.recordSample(N, expiry, [enc(106, expiry + 2)], { value: 10 }); // $106/share x 2 = $212/token
    await po.recordSample(N, expiry, [enc(106, expiry + 4)], { value: 10 });
    await expect(po.recordSample(N, expiry, [enc(106, expiry + 4)], { value: 10 })).to.be.revertedWithCustomError(po, "StaleOrDuplicate");
    await time.increaseTo(expiry + WINDOW + 1);
    expect((await po.settlementPrice(N, expiry))[0]).to.equal(usd(212));

    const n0 = await nvda.balanceOf(buyer.address);
    await protocol.connect(buyer).redeem(callId, sh(10));
    expect((await nvda.balanceOf(buyer.address)) - n0).to.be.closeTo(sh("0.330188679245283018"), 10n);
  });

  it("rejects samples outside the settlement window", async function () {
    const ctx = await loadFixture(deployAll);
    const { po } = await setup(ctx);
    const { N, expiry } = ctx;
    await time.increaseTo(expiry + 5);
    await expect(po.recordSample(N, expiry, [enc(200, expiry - 10)], { value: 10 })).to.be.revertedWithCustomError(po, "OutsideWindow");
    await expect(po.recordSample(N, expiry, [enc(200, expiry + WINDOW + 10)], { value: 10 })).to.be.revertedWithCustomError(po, "OutsideWindow");
  });

  it("spot converts per-share Pyth prices to per-token prices", async function () {
    const ctx = await loadFixture(deployAll);
    const { pyth, po } = await setup(ctx);
    const { nvda, owner, N } = ctx;
    const t = await time.latest();
    await pyth.updatePriceFeeds([enc(200, t)], { value: 1 });
    expect((await po.spot(N))[0]).to.equal(usd(200));
    await nvda.connect(owner).setMultiplier(sh("1.01")); // reinvested dividend
    expect((await po.spot(N))[0]).to.equal(usd(202));
  });
});

describe("Batch quoting", function () {
  it("posts asks and bids for many series in one transaction", async function () {
    const ctx = await loadFixture(deployAll);
    const { protocol, makerA, usdc, N, callId, putId } = ctx;
    await protocol.connect(makerA).deposit(N, sh(10));
    await protocol.connect(makerA).deposit(await usdc.getAddress(), usd(5000));
    await protocol.connect(makerA).postQuotes([callId, callId, putId, putId], [false, true, false, true],
      [usd(2), usd("1.5"), usd(2), usd("1.4")], [sh(10), sh(10), sh(10), sh(10)]);
    const [asks, bids] = await protocol.bookOf(callId);
    expect(asks.length).to.equal(1);
    expect(bids.length).to.equal(1);
    expect((await protocol.quotesOf(makerA.address)).length).to.equal(4);
  });
});

describe("Pause", function () {
  it("stops new risk but never blocks exits or batch cancels", async function () {
    const ctx = await loadFixture(deployAll);
    const { protocol, makerB, buyer, other, N, callId } = ctx;
    await protocol.connect(makerB).deposit(N, sh(20));
    await protocol.connect(makerB).postQuote(callId, usd("1.70"), sh(10));
    await protocol.connect(makerB).postQuote(callId, usd("1.80"), sh(10));
    await protocol.connect(buyer).buy(callId, sh(5), usd(9), buyer.address);
    await expect(protocol.connect(other).pause()).to.be.revertedWithCustomError(protocol, "NotGuardian");
    await protocol.pause();
    await expect(protocol.connect(buyer).buy(callId, sh(1), usd(2), buyer.address)).to.be.revertedWithCustomError(protocol, "IsPaused");
    await expect(protocol.connect(makerB).postQuote(callId, usd(2), sh(1))).to.be.revertedWithCustomError(protocol, "IsPaused");
    const ids = await protocol.quotesOf(makerB.address);
    await expect(protocol.connect(makerB).updateQuotes([ids[0]], [usd(2)], [sh(5)])).to.be.revertedWithCustomError(protocol, "IsPaused");
    await protocol.connect(makerB).updateQuotes([...ids], [0, 0], [0, 0]); // batch cancel still works
    await protocol.connect(buyer).exercise(callId, sh(5)); // exits still work
    await protocol.unpause();
  });
});
