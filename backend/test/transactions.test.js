import { test } from "node:test";
import assert from "node:assert/strict";
import { send, provider, signer } from "../src/lib/chain.js";

test("shared signer queue waits for confirmation and recovers after failure", async () => {
  const events = [];
  let release;
  const confirmed = new Promise(resolve => { release = resolve; });
  const s = { _queue: Promise.resolve(), reset() {} };
  const first = send(s, "first", async () => {
    events.push("first submitted");
    return { wait: async () => { await confirmed; events.push("first confirmed"); return { status: 1 }; } };
  });
  const second = send(s, "second", async () => {
    events.push("second submitted");
    throw Error("submission failed");
  });
  const third = send(s, "third", async () => {
    events.push("third submitted");
    return { wait: async () => ({ status: 1 }) };
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["first submitted"]);
  release();
  const results = await Promise.all([first, second, third]);
  assert.equal(results[1], null);
  assert.equal(results[2].status, 1);
  assert.deepEqual(events, ["first submitted", "first confirmed", "second submitted", "third submitted"]);
});

test("different key casing uses the same signer queue", () => {
  const key = "0x" + "ab".repeat(32);
  assert.equal(signer(key), signer("0x" + "AB".repeat(32)));
  provider.destroy();
});
