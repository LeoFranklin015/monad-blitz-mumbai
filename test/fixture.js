const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const usd = (x) => ethers.parseUnits(String(x), 6);
const sh = (x) => ethers.parseEther(String(x));
const WINDOW = 600; // 10 minute settlement window

async function deployAll() {
  const [owner, makerA, makerB, makerC, buyer, other] = await ethers.getSigners();

  const ERC20 = await ethers.getContractFactory("MockERC20");
  const usdc = await ERC20.deploy("USD Coin", "USDC", 6);
  const nvda = await ERC20.deploy("NVIDIA xStock", "NVDAx", 18);

  const oracle = await (await ethers.getContractFactory("SettlementOracle")).deploy(owner.address, WINDOW);
  const protocol = await (await ethers.getContractFactory("OptionsProtocol")).deploy(
    await usdc.getAddress(),
    await oracle.getAddress(),
    owner.address
  );
  await protocol.setUnderlying(await nvda.getAddress(), true);
  await oracle.pushSpot(await nvda.getAddress(), usd(200));

  const gap = await (await ethers.getContractFactory("GapMarket")).deploy(
    await usdc.getAddress(),
    await oracle.getAddress(),
    owner.address
  );
  const vault = await (await ethers.getContractFactory("CommitVault")).deploy(
    await protocol.getAddress(),
    await nvda.getAddress(),
    "Auto-Commit NVDAx",
    "acNVDAx",
    owner.address
  );
  const lender = await (await ethers.getContractFactory("ShieldedLender")).deploy(
    await protocol.getAddress(),
    await nvda.getAddress(),
    owner.address
  );

  const P = await protocol.getAddress();
  for (const s of [owner, makerA, makerB, makerC, buyer, other]) {
    await usdc.mint(s.address, usd(1_000_000));
    await nvda.mint(s.address, sh(1_000));
    for (const spender of [P, await gap.getAddress(), await vault.getAddress(), await lender.getAddress()]) {
      await usdc.connect(s).approve(spender, ethers.MaxUint256);
      await nvda.connect(s).approve(spender, ethers.MaxUint256);
    }
  }

  // "Monday open" three days out
  const now = await time.latest();
  const expiry = now + 3 * 24 * 3600;
  const N = await nvda.getAddress();
  await protocol.createSeries(N, expiry, true, usd(205));
  await protocol.createSeries(N, expiry, false, usd(195));
  const callId = 0n;
  const putId = 1n;

  const tokenOf = async (id) => ethers.getContractAt("OptionToken", (await protocol.getSeries(id)).token);

  return { owner, makerA, makerB, makerC, buyer, other, usdc, nvda, oracle, protocol, gap, vault, lender, expiry, callId, putId, tokenOf, N };
}

/// Post settlement samples inside the window, then step past it.
async function settleAt(ctx, prices) {
  await time.increaseTo(ctx.expiry + 1);
  for (const p of prices) await ctx.oracle.pushSample(ctx.N, ctx.expiry, usd(p));
  await time.increaseTo(ctx.expiry + WINDOW + 1);
}

module.exports = { deployAll, settleAt, usd, sh, WINDOW };
