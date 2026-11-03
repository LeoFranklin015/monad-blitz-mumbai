// Incremental event indexer. Reads logs in bounded block ranges from the deploy block forward,
// persists its cursor and derived sets to DATA_DIR, and survives restarts. Public RPCs reject
// unbounded eth_getLogs, so nothing in the backend scans from block 0.
//
// Tracks: option holders and writers per series, borrowers per lender, gap bettors per round,
// and every fill (for metrics and hedging).
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { D, ABI, NETWORK, config } from "../config.js";
import { provider } from "./chain.js";
import { log, metrics } from "./obs.js";

const proto = new ethers.Interface(ABI.OptionsProtocol);
const lenderI = new ethers.Interface(ABI.ShieldedLender);
const gapI = new ethers.Interface(ABI.GapMarket);
const TRANSFER = ethers.id("Transfer(address,address,uint256)");
const ZERO = ethers.ZeroAddress;

const file = () => path.join(config.dataDir, `indexer-${NETWORK}-${D.protocol.toLowerCase()}.json`);

const S = {
  next: D.deployBlock ?? 0,
  tokens: {}, // token -> seriesId
  holders: {}, // seriesId -> [addr]
  writers: {}, // seriesId -> [addr]
  borrowers: {}, // lender -> [addr]
  bettors: {}, // roundId -> [addr]
  fills: 0,
};
const sets = { holders: new Map(), writers: new Map(), borrowers: new Map(), bettors: new Map() };

function add(kind, k, a) {
  if (!a || a === ZERO) return;
  if (!sets[kind].has(k)) sets[kind].set(k, new Set());
  sets[kind].get(k).add(ethers.getAddress(a));
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(file(), "utf8"));
    Object.assign(S, j);
    for (const kind of Object.keys(sets)) for (const [k, arr] of Object.entries(j[kind] || {})) arr.forEach((a) => add(kind, k, a));
    log(`indexer: resumed at block ${S.next}`);
  } catch {
    log(`indexer: starting at block ${S.next}`);
  }
}

function save() {
  for (const kind of Object.keys(sets)) S[kind] = Object.fromEntries([...sets[kind]].map(([k, v]) => [k, [...v]]));
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = file() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(S));
  fs.renameSync(tmp, file());
}

async function getLogs(filter, from, to) {
  // Halve the range on RPC errors (range or result-size limits), down to single blocks.
  try {
    return await provider.getLogs({ ...filter, fromBlock: from, toBlock: to });
  } catch (e) {
    if (to <= from) throw e;
    const mid = Math.floor((from + to) / 2);
    return [...(await getLogs(filter, from, mid)), ...(await getLogs(filter, mid + 1, to))];
  }
}

function onProtocol(l) {
  let ev;
  try {
    ev = proto.parseLog(l);
  } catch {
    return;
  }
  if (!ev) return;
  const a = ev.args;
  switch (ev.name) {
    case "SeriesCreated":
      S.tokens[a.token.toLowerCase()] = Number(a.seriesId);
      break;
    case "Filled":
      add("writers", String(a.seriesId), a.seller);
      S.fills++;
      metrics.inc("fills_total");
      break;
    case "RFQFilled":
      add("writers", String(a.seriesId), a.maker);
      S.fills++;
      metrics.inc("fills_total", { via: "rfq" });
      break;
  }
}

function onToken(l) {
  const id = S.tokens[l.address.toLowerCase()];
  if (id === undefined || l.topics[0] !== TRANSFER) return;
  add("holders", String(id), ethers.getAddress("0x" + l.topics[2].slice(26)));
}

function onLender(l) {
  try {
    const ev = lenderI.parseLog(l);
    if (ev?.name === "CollateralIn") add("borrowers", l.address.toLowerCase(), ev.args.user);
  } catch {}
}

function onGap(l) {
  try {
    const ev = gapI.parseLog(l);
    if (ev?.name === "Bet") add("bettors", String(ev.args.id), ev.args.user);
  } catch {}
}

let running = false;
export async function sync() {
  if (running) return;
  running = true;
  try {
    const head = (await provider.getBlockNumber()) - config.confirmations;
    while (S.next <= head) {
      const from = S.next;
      const to = Math.min(head, from + config.logChunk - 1);
      // protocol first so tokens created in this range are known before their transfers are read
      (await getLogs({ address: D.protocol }, from, to)).forEach(onProtocol);
      const tokens = Object.keys(S.tokens);
      for (let i = 0; i < tokens.length; i += 400) {
        (await getLogs({ address: tokens.slice(i, i + 400), topics: [TRANSFER] }, from, to)).forEach(onToken);
      }
      (await getLogs({ address: D.stocks.map((s) => s.lender) }, from, to)).forEach(onLender);
      (await getLogs({ address: D.gap }, from, to)).forEach(onGap);
      S.next = to + 1;
      save();
    }
    metrics.set("indexer_block", null, S.next - 1);
    metrics.beat("indexer");
  } finally {
    running = false;
  }
}

export const index = {
  load,
  holders: (id) => [...(sets.holders.get(String(id)) || [])],
  writers: (id) => [...(sets.writers.get(String(id)) || [])],
  borrowers: (lender) => [...(sets.borrowers.get(lender.toLowerCase()) || [])],
  bettors: (round) => [...(sets.bettors.get(String(round)) || [])],
  block: () => S.next - 1,
};
