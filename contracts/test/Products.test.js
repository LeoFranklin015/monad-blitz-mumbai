const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployAll, settleAt, usd, sh } = require("./fixture");

describe("Weekend Gap market", function () {
  it("pays the side that called Monday's open, minus a fee on the losing pool", async function () {
    const ctx = await loadFixture(deployAll);
    const { gap, makerA, makerB, oracle, usdc, N, expiry, owner } = ctx;
    const now = await time.latest();
    await gap.openRound(N, now, expiry, usd(200));
    await gap.connect(makerA).bet(0, true, usd(100));
    await gap.connect(makerB).bet(0, false, usd(300));
    expect(await gap.impliedUpBps(0)).to.equal(2500n);
    await expect(gap.connect(makerA).settle(0)).to.be.revertedWithCustomError(gap, "NotLocked");

    await settleAt(ctx, [210]);
    const a0 = await usdc.balanceOf(makerA.address);
    const o0 = await usdc.balanceOf(owner.address);
    await gap.connect(makerA).claim(0);
    expect((await usdc.balanceOf(makerA.address)) - a0).to.equal(usd(397));
    expect((await usdc.balanceOf(owner.address)) - o0).to.equal(usd(3));
    await expect(gap.connect(makerB).claim(0)).to.be.revertedWithCustomError(gap, "Nothing");
    void oracle;
  });

  it("refunds everyone on a flat open", async function () {
    const ctx = await loadFixture(deployAll);
    const { gap, makerA, makerB, usdc, N, expiry } = ctx;
    await gap.openRound(N, await time.latest(), expiry, usd(200));
    await gap.connect(makerA).bet(0, true, usd(50));
    await gap.connect(makerB).bet(0, false, usd(50));
    await settleAt(ctx, [200]);
    const b0 = await usdc.balanceOf(makerB.address);
    await gap.connect(makerB).claim(0);
    expect((await usdc.balanceOf(makerB.address)) - b0).to.equal(usd(50));
  });

  it("locks betting at Monday open", async function () {
    const ctx = await loadFixture(deployAll);
    const { gap, makerA, N, expiry } = ctx;
    await gap.openRound(N, await time.latest(), expiry, usd(200));
    await time.increaseTo(expiry);
    await expect(gap.connect(makerA).bet(0, true, usd(1))).to.be.revertedWithCustomError(gap, "Locked");
  });
});

describe("Auto-Commit vault", function () {
  it("only writes inside its rules", async function () {
    const ctx = await loadFixture(deployAll);
    const { vault, protocol, makerA, N, expiry } = ctx;
    await vault.connect(makerA).deposit(sh(10));
    await protocol.createSeries(N, expiry, 0, usd(202), 0); // 1% OTM, too close
    await expect(vault.startRound(2, usd("1.00"))).to.be.revertedWithCustomError(vault, "RuleBroken");
    await expect(vault.startRound(0, usd("0.10"))).to.be.revertedWithCustomError(vault, "RuleBroken"); // premium too low
    await expect(vault.connect(makerA).startRound(0, usd("1.00"))).to.be.revertedWithCustomError(vault, "NotKeeper");
  });

  it("writes weekly calls, earns premium, rolls back to idle, pays depositors", async function () {
    const ctx = await loadFixture(deployAll);
    const { vault, protocol, makerA, buyer, nvda, usdc, N, expiry } = ctx;
    await protocol.createSeries(N, expiry, 0, usd(210), 0); // 5% OTM
    const callId = 2n;
    await vault.connect(makerA).deposit(sh(10));
    await vault.startRound(callId, usd("1.50"));
    await expect(vault.connect(makerA).deposit(sh(1))).to.be.revertedWithCustomError(vault, "RoundActive");

    await vault.reprice(usd("1.40"));
    await protocol.connect(buyer).buy(callId, sh(5), usd(7), buyer.address);
    expect(await usdc.balanceOf(await vault.getAddress())).to.equal(usd("6.993")); // after 0.1% fee

    await settleAt(ctx, [200]); // out of the money
    await vault.connect(buyer).endRound(); // anyone can end it
    expect(await vault.active()).to.equal(false);

    const n0 = await nvda.balanceOf(makerA.address);
    const u0 = await usdc.balanceOf(makerA.address);
    await vault.connect(makerA).withdraw(await vault.balanceOf(makerA.address));
    expect((await nvda.balanceOf(makerA.address)) - n0).to.equal(sh(10));
    expect((await usdc.balanceOf(makerA.address)) - u0).to.equal(usd("6.993"));
  });
});

describe("ShieldedLender: composable weekend protection", function () {
  async function setup(ctx) {
    const { protocol, lender, makerA, owner, usdc, putId } = ctx;
    await lender.connect(owner).fund(usd(100_000));
    await protocol.connect(makerA).deposit(await usdc.getAddress(), usd(19_500));
    await protocol.connect(makerA).postQuote(putId, usd("1.60"), sh(100));
  }

  it("a weekend crash liquidates the plain loan but not the floored one", async function () {
    const ctx = await loadFixture(deployAll);
    await setup(ctx);
    const { lender, buyer, other, oracle, owner, N, putId } = ctx;

    // both borrow $1,000 against 10 NVDAx at $200
    for (const u of [buyer, other]) {
      await lender.connect(u).depositCollateral(sh(10));
      await lender.connect(u).borrow(usd(1000));
    }
    // only `other` buys a weekend Floor at $195, from inside the lender, in one call
    await lender.connect(other).buyFloor(putId, sh(10), usd(16));

    await time.increase(24 * 3600);
    await oracle.pushSpot(N, usd(140)); // -30% Saturday

    expect(await lender.isLiquidatable(buyer.address)).to.equal(true);
    expect(await lender.isLiquidatable(other.address)).to.equal(false);

    await lender.connect(owner).liquidate(buyer.address);
    await expect(lender.connect(owner).liquidate(other.address)).to.be.revertedWithCustomError(lender, "Healthy");
  });

  it("borrower can exercise the Floor through the lender and repay at the strike", async function () {
    const ctx = await loadFixture(deployAll);
    await setup(ctx);
    const { lender, other, oracle, usdc, N, putId } = ctx;
    await lender.connect(other).depositCollateral(sh(10));
    await lender.connect(other).borrow(usd(1000));
    await lender.connect(other).buyFloor(putId, sh(10), usd(16));
    await oracle.pushSpot(N, usd(140));

    const u0 = await usdc.balanceOf(other.address);
    await lender.connect(other).useFloor(sh(10));
    const acct = await lender.accounts(other.address);
    expect(acct.debt).to.equal(0n);
    expect(acct.collateral).to.equal(0n);
    expect((await usdc.balanceOf(other.address)) - u0).to.equal(usd(950)); // 1950 - 1000 debt
  });
});
