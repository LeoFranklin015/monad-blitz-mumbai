import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");
const env = process.env;

// Load backend/.env if present (no dependency needed). Real env vars win.
const envFile = path.join(here, "..", ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export const NETWORK = env.NETWORK || "localhost";
const depDir = env.DEPLOYMENTS_DIR || path.join(root, "deployments");
const depPath = path.join(depDir, `${NETWORK}.json`);
if (!fs.existsSync(depPath)) {
  console.error(`No deployment at ${depPath}. Deploy first (npm run deploy:local).`);
  process.exit(1);
}

export const D = JSON.parse(fs.readFileSync(depPath, "utf8"));
export const ABI = JSON.parse(fs.readFileSync(path.join(depDir, "abi.json"), "utf8"));
export const LOCAL = D.chainId === 31337;

// Local chain only: keys derived from Hardhat's public dev mnemonic. Never used on a live network.
const DEV_MNEMONIC = "test test test test test test test test test test test junk";
const dev = (i) => (LOCAL ? ethers.HDNodeWallet.fromPhrase(DEV_MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).privateKey : null);

const list = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);
const num = (k, d) => (env[k] !== undefined && env[k] !== "" ? Number(env[k]) : d);

export const config = {
  rpc: env.RPC_URL || D.rpc,
  dataDir: env.DATA_DIR || path.join(here, "..", "data"),
  logFormat: env.LOG_FORMAT || "text", // text | json

  // service keys: one per role on live networks
  reporterKey: env.REPORTER_KEY || dev(12),
  keeperKey: env.KEEPER_KEY || dev(10),
  hedgerKey: env.HEDGER_KEY || dev(11),
  makerKeys: env.MAKER_KEYS ? list(env.MAKER_KEYS) : LOCAL ? [dev(1), dev(2), dev(3)] : [],
  operatorKey: env.OPERATOR_KEY || dev(4),

  // loops
  tickMs: num("TICK_MS", LOCAL ? 2000 : 1000),
  keeperMs: num("KEEPER_MS", 5000),
  hedgerMs: num("HEDGER_MS", 5000),
  simulate: env.SIMULATE ? env.SIMULATE === "1" : LOCAL && D.oracleKind === "reporter",

  // api
  port: num("PORT", num("RFQ_PORT", 8787)),
  corsOrigins: list(env.CORS_ORIGINS || "*"),
  rateLimitPerMin: num("RATE_LIMIT_PER_MIN", 120),
  rfqTtlSec: num("RFQ_TTL_SEC", 60),
  rfqSpread: num("RFQ_SPREAD", 0.03),
  rfqMaxSize: num("RFQ_MAX_SIZE", 500),

  // quoting
  requoteBps: num("REQUOTE_BPS", 100),
  askSize: num("ASK_SIZE", 25),
  bidSize: num("BID_SIZE", 15),

  // risk
  maxStaleSec: num("MAX_STALE_SEC", 120), // oracle spot older than this while the market is open pulls all quotes
  jumpPct: num("JUMP_PCT", 0.06), // spot moving more than this in one tick pulls quotes for a cooldown
  jumpCooldownSec: num("JUMP_COOLDOWN_SEC", 60),
  stopBeforeExpirySec: num("STOP_BEFORE_EXPIRY_SEC", 300), // no quotes in the last minutes before expiry
  maxShortDelta: num("MAX_SHORT_DELTA", 5000), // per stock, in shares; makers stop selling beyond this

  // hedging
  hedgeMode: env.HEDGE_MODE || (LOCAL ? "mockdex" : "off"), // off | mockdex | kuru
  hedgeThreshold: num("HEDGE_THRESHOLD", 1), // shares of net delta before trading
  hedgeMaxSlippageBps: num("HEDGE_MAX_SLIPPAGE_BPS", 100),
  kuruApi: env.KURU_API_URL || "https://ws.kuru.io/api",

  // chain reading
  logChunk: num("LOG_CHUNK", LOCAL ? 5000 : 500),
  confirmations: num("CONFIRMATIONS", LOCAL ? 0 : 2),

  // pyth
  hermes: env.HERMES_URL || "https://hermes.pyth.network",
  pythIds: Object.fromEntries(list(env.PYTH_IDS).map((kv) => kv.split("="))),
};

export const KIND = { CALL: 0, PUT: 1, CALL_SPREAD: 2, PUT_SPREAD: 3 };
export const KIND_NAME = ["Upside", "Floor", "Capped Upside", "Budget Floor"];

/// Fail fast on a live network if a required key is missing for a service that needs it.
export function requireKey(name, key) {
  if (!key) throw new Error(`${name} is not set. Set it in backend/.env or the environment.`);
  return key;
}
