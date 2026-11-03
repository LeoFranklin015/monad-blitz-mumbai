const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployAll, settleAt, usd, sh } = require("./fixture");

async function threeMakersQuoteUpside(ctx) {
  const { protocol, makerA, makerB, makerC, N, callId } = ctx;
  for (const [m, px] of [[makerA, "1.80"], [makerB, "1.70"], [makerC, "1.75"]]) {
    await protocol.connect(m).deposit(N, sh(10));
    await protocol.connect(m).postQuote(callId, usd(px), sh(10));
  }
}

describe("Upside lifecycle (call)", function () {
  it("makers lock collateral and quote; quotes cannot exist without collateral", async function () {
    const ctx = await loadFixture(deployAll);
    const { protocol, makerA, other, N, callId } = ctx;
    await expect(protocol.connect(other).postQuote(callId, usd(1), sh(1))).to.be.revertedWithCustomError(
      protocol,
      "InsufficientBalance"
    );
    await threeMakersQuoteUpside(ctx);
    expect(await protocol.freeBalance(makerA.address, N)).to.equal(0n);
    await expect(protocol.connect(makerA).withdraw(N, 1n)).to.be.revertedWithCustomError(protocol, "InsufficientBalance");
    const [qs] = await protocol.bookOf(callId);
    expect(qs.length).to.equal(3);
  });

  it("makers reprice every block with a batch update", async function () {
    const ctx = await loadFixture(deployAll);
    await threeMakersQuoteUpside(ctx);
    const { protocol, makerA, callId } = ctx;
    await protocol.connect(makerA).updateQuotes([0], [usd("1.65")], [sh(10)]);
    const [p] = await protocol.quoteBuy(callId, sh(10));
    expect(p).to.equal(usd("16.5"));
  });

  it("buyer fills the best quote, pays a fixed premium, gets a transferable Upside", async function () {
    const ctx = await loadFixture(deployAll);
    await threeMakersQuoteUpside(ctx);
    const { protocol, buyer, makerB, owner, usdc, callId, tokenOf } = ctx;
    const b0 = await usdc.balanceOf(makerB.address);
    const t0 = await usdc.balanceOf(owner.address);
    await expect(protocol.connect(buyer).buy(callId, sh(10), usd(17), buyer.address)).to.emit(protocol, "Filled");
    const fee = usd("0.017");
    expect((await usdc.balanceOf(makerB.address)) - b0).to.equal(usd(17) - fee);
    expect((await usdc.balanceOf(owner.address)) - t0).to.equal(fee);
    expect(await (await tokenOf(callId)).balanceOf(buyer.address)).to.equal(sh(10));
    expect(await protocol.written(callId, makerB.address)).to.equal(sh(10));
  });

  it("a fill walks the book across makers, best price first", async function () {
    const ctx = await loadFixture(deployAll);
    await threeMakersQuoteUpside(ctx);
    const { protocol, buyer, makerB, makerC, callId } = ctx;
    // 10 @1.70 (B) + 5 @1.75 (C) = 17 + 8.75
    await protocol.connect(buyer).buy(callId, sh(15), usd("25.75"), buyer.address);
    expect(await protocol.written(callId, makerB.address)).to.equal(sh(10));
    expect(await protocol.written(callId, makerC.address)).to.equal(sh(5));
    const [qs] = await protocol.bookOf(callId);
    expect(qs.length).to.equal(2);
  });

  it("reverts on slippage and on thin books", async function () {
    const ctx = await loadFixture(deployAll);
    await threeMakersQuoteUpside(ctx);
    const { protocol, buyer, callId } = ctx;
    await expect(protocol.connect(buyer).buy(callId, sh(10), usd(16), buyer.address)).to.be.revertedWithCustomError(
      protocol,
      "Slippage"
    );
    await expect(protocol.connect(buyer).buy(callId, sh(31), usd(1000), buyer.address)).to.be.revertedWithCustomError(
      protocol,
      "InsufficientLiquidity"
    );
  });

  it("a Saturday wick changes nothing: no margin, no liquidation, collateral stays", async function () {
    const ctx = await loadFixture(deployAll);
    await threeMakersQuoteUpside(ctx);
    const { protocol, buyer, oracle, N, callId, tokenOf } = ctx;
    await protocol.connect(buyer).buy(callId, sh(10), usd(17), buyer.address);
    await time.increase(24 * 3600);
    await oracle.pushSpot(N, usd(178)); // -11%
    expect(await (await tokenOf(callId)).balanceOf(buyer.address)).to.equal(sh(10));
    expect((await protocol.getSeries(callId)).poolUnderlying).to.equal(sh(10));
  });

  it("Monday: buyer exercises physically, pays strike, receives real stock; no oracle read", async function () {
    const ctx = await loadFixture(deployAll);
    await threeMakersQuoteUpside(ctx);
    const { protocol, buyer, makerB, usdc, nvda, N, callId, expiry } = ctx;
    await protocol.connect(buyer).buy(callId, sh(10), usd(17), buyer.address);
    await time.increaseTo(expiry - 60);
    const n0 = await nvda.balanceOf(buyer.address);
    const u0 = await usdc.balanceOf(buyer.address);
    await protocol.connect(buyer).exercise(callId, sh(10));
    expect((await nvda.balanceOf(buyer.address)) - n0).to.equal(sh(10));
    expect(u0 - (await usdc.balanceOf(buyer.address))).to.equal(usd(2050));

    // writer gets the strike after expiry, settled with no exercises left outstanding
    await settleAt(ctx, [212]);
    await protocol.connect(makerB).claim(callId);
    expect(await protocol.freeBalance(makerB.address, await usdc.getAddress())).to.equal(usd(2050));
    expect(await protocol.freeBalance(makerB.address, N)).to.equal(0n);
  });

  it("auto net settlement: unexercised in-the-money Upside pays the profit in stock", async function () {
    const ctx = await loadFixture(deployAll);
    await threeMakersQuoteUpside(ctx);
    const { protocol, buyer, makerB, makerA, makerC, nvda, N, callId } = ctx;
    await protocol.connect(buyer).buy(callId, sh(10), usd(17), buyer.address);
    await settleAt(ctx, [211, 212, 213]); // TWAP 212
    const n0 = await nvda.balanceOf(buyer.address);
    await protocol.connect(buyer).redeem(callId, sh(10));
    const got = (await nvda.balanceOf(buyer.address)) - n0;
    // 10 * (212 - 205) / 212 = 0.33018867... shares, worth $70
    expect(got).to.be.closeTo(sh("0.330188679245283018"), 10n);
    await protocol.connect(makerB).claim(callId);
    expect(await protocol.freeBalance(makerB.address, N)).to.be.closeTo(sh("9.669811320754716981"), 10n);
    // unfilled makers pull their collateral back after expiry
    await protocol.connect(makerA).cancelQuote(0);
    await protocol.connect(makerC).cancelQuote(2);
    expect(await protocol.freeBalance(makerA.address, N)).to.equal(sh(10));
  });

  it("out of the money: buyer loses only the premium, writer gets the stock back", async function () {
    const ctx = await loadFixture(deployAll);
    await threeMakersQuoteUpside(ctx);
    const { protocol, buyer, makerB, nvda, N, callId } = ctx;
    await protocol.connect(buyer).buy(callId, sh(10), usd(17), buyer.address);
    await settleAt(ctx, [201]);
    const n0 = await nvda.balanceOf(buyer.address);
    await protocol.connect(buyer).redeem(callId, sh(10));
    expect(await nvda.balanceOf(buyer.address)).to.equal(n0);
    await protocol.connect(makerB).claim(callId);
    expect(await protocol.freeBalance(makerB.address, N)).to.equal(sh(10));
  });

  it("cannot trade or exercise after expiry; settlement waits for the window", async function () {
    const ctx = await loadFixture(deployAll);
    await threeMakersQuoteUpside(ctx);
    const { protocol, buyer, callId, expiry } = ctx;
    await protocol.connect(buyer).buy(callId, sh(1), usd(2), buyer.address);
    await time.increaseTo(expiry + 1);
    await expect(protocol.connect(buyer).buy(callId, sh(1), usd(2), buyer.address)).to.be.revertedWithCustomError(protocol, "Expired");
    await expect(protocol.connect(buyer).exercise(callId, sh(1))).to.be.revertedWithCustomError(protocol, "Expired");
    await expect(protocol.settle(callId)).to.be.revertedWithCustomError(protocol, "OracleNotReady");
  });

  it("if the oracle never reports, unexercised options settle worthless after the grace period", async function () {
    const ctx = await loadFixture(deployAll);
    await threeMakersQuoteUpside(ctx);
    const { protocol, buyer, makerB, N, callId, expiry } = ctx;
    await protocol.connect(buyer).buy(callId, sh(10), usd(17), buyer.address);
    await time.increaseTo(expiry + 7 * 24 * 3600 + 1);
    await protocol.settle(callId);
    await protocol.connect(makerB).claim(callId);
    expect(await protocol.freeBalance(makerB.address, N)).to.equal(sh(10));
  });

  it("writer can buy back and close to unlock collateral early", async function () {
    const ctx = await loadFixture(deployAll);
    await threeMakersQuoteUpside(ctx);
    const { protocol, buyer, makerB, N, callId, tokenOf } = ctx;
    await protocol.connect(buyer).buy(callId, sh(10), usd(17), buyer.address);
    await (await tokenOf(callId)).connect(buyer).transfer(makerB.address, sh(4));
    await protocol.connect(makerB).close(callId, sh(4));
    expect(await protocol.freeBalance(makerB.address, N)).to.equal(sh(4));
    expect(await protocol.written(callId, makerB.address)).to.equal(sh(6));
  });
});

describe("Floor lifecycle (put)", function () {
  it("maker locks USDC; buyer exits on a Saturday at the strike", async function () {
    const ctx = await loadFixture(deployAll);
    const { protocol, makerA, buyer, usdc, nvda, oracle, N, putId, expiry } = ctx;
    const U = await usdc.getAddress();
    await protocol.connect(makerA).deposit(U, usd(1950));
    await protocol.connect(makerA).postQuote(putId, usd("1.60"), sh(10));
    expect(await protocol.freeBalance(makerA.address, U)).to.equal(0n);

    await protocol.connect(buyer).buy(putId, sh(10), usd(16), buyer.address);
    await time.increase(24 * 3600); // Saturday
    await oracle.pushSpot(N, usd(170));
    const u0 = await usdc.balanceOf(buyer.address);
    await protocol.connect(buyer).exercise(putId, sh(10));
    expect((await usdc.balanceOf(buyer.address)) - u0).to.equal(usd(1950));

    await settleAt(ctx, [172]);
    await protocol.connect(makerA).claim(putId);
    expect(await protocol.freeBalance(makerA.address, N)).to.equal(sh(10));
    void expiry;
    void nvda;
  });

  it("net settles an unexercised Floor in USDC", async function () {
    const ctx = await loadFixture(deployAll);
    const { protocol, makerA, buyer, usdc, putId } = ctx;
    const U = await usdc.getAddress();
    await protocol.connect(makerA).deposit(U, usd(1950));
    await protocol.connect(makerA).postQuote(putId, usd("1.60"), sh(10));
    await protocol.connect(buyer).buy(putId, sh(10), usd(16), buyer.address);
    await settleAt(ctx, [185]);
    const u0 = await usdc.balanceOf(buyer.address);
    await protocol.connect(buyer).redeem(putId, sh(10));
    expect((await usdc.balanceOf(buyer.address)) - u0).to.equal(usd(100));
    await protocol.connect(makerA).claim(putId);
    expect(await protocol.freeBalance(makerA.address, U)).to.equal(usd(1850));
  });
});

describe("Signed RFQ", function () {
  async function signRFQ(ctx, maker, overrides = {}) {
    const { protocol, callId } = ctx;
    const r = {
      maker: maker.address,
      seriesId: callId,
      price: usd("1.55"),
      maxSize: sh(10),
      nonce: 1n,
      deadline: BigInt((await time.latest()) + 600),
      ...overrides,
    };
    const domain = {
      name: "WeekendOptions",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await protocol.getAddress(),
    };
    const types = {
      RFQ: [
        { name: "maker", type: "address" },
        { name: "seriesId", type: "uint256" },
        { name: "price", type: "uint256" },
        { name: "maxSize", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    return { r, sig: await maker.signTypedData(domain, types, r) };
  }

  it("fills a signed quote in parts, up to its size", async function () {
    const ctx = await loadFixture(deployAll);
    const { protocol, makerA, buyer, N, callId, tokenOf } = ctx;
    await protocol.connect(makerA).deposit(N, sh(10));
    const { r, sig } = await signRFQ(ctx, makerA);
    await protocol.connect(buyer).fillRFQ(r, sig, sh(4), buyer.address);
    await protocol.connect(buyer).fillRFQ(r, sig, sh(6), buyer.address);
    expect(await (await tokenOf(callId)).balanceOf(buyer.address)).to.equal(sh(10));
    await expect(protocol.connect(buyer).fillRFQ(r, sig, sh(1), buyer.address)).to.be.revertedWithCustomError(protocol, "BadAmount");
  });

  it("rejects forged, expired and cancelled quotes", async function () {
    const ctx = await loadFixture(deployAll);
    const { protocol, makerA, makerB, buyer, N } = ctx;
    await protocol.connect(makerA).deposit(N, sh(10));
    const { r, sig } = await signRFQ(ctx, makerB, { maker: makerA.address });
    await expect(protocol.connect(buyer).fillRFQ(r, sig, sh(1), buyer.address)).to.be.revertedWithCustomError(protocol, "BadSignature");

    const good = await signRFQ(ctx, makerA, { nonce: 7n });
    await protocol.connect(makerA).cancelRFQ(7n);
    await expect(protocol.connect(buyer).fillRFQ(good.r, good.sig, sh(1), buyer.address)).to.be.revertedWithCustomError(protocol, "Expired");

    const old = await signRFQ(ctx, makerA, { nonce: 8n, deadline: 1n });
    await expect(protocol.connect(buyer).fillRFQ(old.r, old.sig, sh(1), buyer.address)).to.be.revertedWithCustomError(protocol, "Expired");
  });
});
