// Unit tests for the Mera passkey account layer (web/src/mera.js).
// Run: npm test -w web            (pure tests)
//      MERA_TEST_RPC=http://127.0.0.1:8646 npm test -w web   (adds a real send on a Hardhat node)
import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { deriveEvmPrivateKey } from "@category-labs/mera";
import { deriveEvmKey, recoveryPhrase, openSession, MeraSigner, isMeraError, meraMessage } from "../src/mera.js";

// A fixed PRF output (bytes 0..31) stands in for what the passkey returns.
const PRF = Uint8Array.from({ length: 32 }, (_, i) => i);

test("derivation follows BIP-44 m/44'/60'/0'/0/0 and matches Mera's own derivation", () => {
  const key = deriveEvmKey(PRF);
  assert.equal(ethers.hexlify(key), ethers.hexlify(deriveEvmPrivateKey({ prfOutput: PRF, accountIndex: 0 })));
});

test("the 24-word recovery phrase imports as the same address (MetaMask/Rabby path)", () => {
  const words = recoveryPhrase(PRF);
  assert.equal(words.split(" ").length, 24);
  const { session, account } = openSession(PRF);
  const imported = ethers.HDNodeWallet.fromPhrase(words, undefined, "m/44'/60'/0'/0/0");
  assert.equal(account.address, imported.address);
  assert.equal(account.address, new ethers.Wallet(ethers.hexlify(deriveEvmKey(PRF))).address);
  session.end();
});

test("signer signs messages, typed data and transactions as the derived address", async () => {
  const { session, account } = openSession(PRF);
  const s = new MeraSigner(account, null);
  assert.equal(await s.getAddress(), account.address);

  const sig = await s.signMessage("hello weekend");
  assert.equal(ethers.verifyMessage("hello weekend", sig), account.address);
  const bsig = await s.signMessage(new Uint8Array([1, 2, 3]));
  assert.equal(ethers.verifyMessage(new Uint8Array([1, 2, 3]), bsig), account.address);

  const domain = { name: "OptionsProtocol", version: "1", chainId: 31337, verifyingContract: "0x5FbDB2315678afecb367f032d93F642f64180aa3" };
  const types = { Quote: [{ name: "maker", type: "address" }, { name: "seriesId", type: "uint256" }, { name: "price", type: "uint256" }] };
  const value = { maker: account.address, seriesId: 3n, price: 1_250_000n };
  const tsig = await s.signTypedData(domain, types, value);
  assert.equal(ethers.verifyTypedData(domain, types, value, tsig), account.address);

  const tx = ethers.Transaction.from({ type: 2, chainId: 10143, nonce: 7, to: ethers.ZeroAddress, value: 1n, data: "0x1234", gasLimit: 50_000n, maxFeePerGas: 100n * 10n ** 9n, maxPriorityFeePerGas: 2n * 10n ** 9n });
  const raw = await s.signTransaction(tx);
  const back = ethers.Transaction.from(raw);
  assert.equal(back.from, account.address);
  assert.equal(back.gasLimit, 50_000n);
  assert.equal(back.chainId, 10143n);

  const legacy = await s.signTransaction(ethers.Transaction.from({ type: 0, chainId: 31337, nonce: 0, to: ethers.ZeroAddress, gasLimit: 21_000n, gasPrice: 10n ** 9n }));
  assert.equal(ethers.Transaction.from(legacy).from, account.address);
  session.end();
});

test("signing after the session ends fails with SESSION_ENDED and clear copy", async () => {
  const { session, account } = openSession(PRF);
  session.end();
  const s = new MeraSigner(account, null);
  const err = await s.signMessage("x").then(() => null, (e) => e);
  assert.ok(isMeraError(err));
  assert.equal(err.code, "SESSION_ENDED");
  assert.match(meraMessage(err), /sign in again/i);
});

test("Mera error codes map to plain copy", () => {
  const e = (code) => Object.assign(new Error(code), { name: "MeraError", code });
  assert.match(meraMessage(e("PRF_UNAVAILABLE")), /Google Password Manager/);
  assert.match(meraMessage(e("PASSKEY_OPERATION_FAILED")), /passkey/i);
  assert.match(meraMessage(e("PASSKEY_CANCELLED")), /dismissed/i);
  assert.match(meraMessage(e("CRYPTO_UNAVAILABLE")), /https|localhost/i);
  assert.equal(isMeraError(new Error("x")), false);
  assert.equal(meraMessage(new Error("x")), null);
});

test("sends a transaction on a live chain with gas limit = estimate x 1.2", { skip: !process.env.MERA_TEST_RPC }, async () => {
  const p = new ethers.JsonRpcProvider(process.env.MERA_TEST_RPC, undefined, { staticNetwork: true });
  const { session, account } = openSession(crypto.getRandomValues(new Uint8Array(32)));
  const funder = await p.getSigner(0);
  await (await funder.sendTransaction({ to: account.address, value: ethers.parseEther("1") })).wait();
  const s = new MeraSigner(account, p);
  const to = ethers.Wallet.createRandom().address;
  const est = await p.estimateGas({ from: account.address, to, value: 123n });
  const tx = await s.sendTransaction({ to, value: 123n });
  const rc = await tx.wait();
  assert.equal(rc.status, 1);
  assert.equal(rc.from, account.address);
  assert.equal(tx.gasLimit, (est * 12n) / 10n);
  assert.equal(await p.getBalance(to), 123n);
  // back-to-back sends right after a mined one must not reuse a nonce
  for (let i = 0; i < 3; i++) assert.equal((await (await s.sendTransaction({ to, value: 1n })).wait()).status, 1);
  session.end();
});
