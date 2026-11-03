// Ops drill against a running local stack: pause pulls quotes, unpause restores them,
// SIGTERM cancels everything, a restart resumes the indexer where it left off.
//   node scripts/ops-drill.mjs <backend-pid-file>
import { ethers } from "ethers";
import fs from "node:fs";

const root = new URL("../../", import.meta.url).pathname;
const D = JSON.parse(fs.readFileSync(root + "deployments/localhost.json"));
const ABI = JSON.parse(fs.readFileSync(root + "deployments/abi.json"));
const p = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
const guardian = await p.getSigner(0);
const pr = new ethers.Contract(D.protocol, ABI.OptionsProtocol, guardian);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = async () => (await fetch("http://127.0.0.1:8787/status")).json();

async function botQuotes() {
  const makers = [];
  for (let i = 1; i <= 3; i++) makers.push(ethers.HDNodeWallet.fromPhrase("test test test test test test test test test test test junk", undefined, `m/44'/60'/0'/0/${i}`).address);
  makers.push(D.hedgedMaker);
  let live = 0;
  for (const m of makers) {
    const ids = await pr.quotesOf(m);
    const qs = await Promise.all(ids.map((i) => pr.getQuote(i)));
    live += qs.filter((q) => q.size > 0n).length;
  }
  return live;
}

const out = (k, v) => console.log(k.padEnd(28), v);
out("live quotes at start", await botQuotes());
out("status", JSON.stringify((await status()).serviceTickAgeSec));

await (await pr.pause()).wait();
await sleep(15000);
out("live quotes after pause", await botQuotes());
await (await pr.unpause()).wait();
await sleep(25000);
out("live quotes after unpause", await botQuotes());
