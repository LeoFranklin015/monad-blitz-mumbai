import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");

// Well-known Hardhat dev keys. Only used for the local chain.
const DEV_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // #0 deployer, reporter, keeper
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // #1 maker
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // #2 maker
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // #3 maker
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // #4 hedged maker operator
];

const env = process.env;
export const NETWORK = env.NETWORK || "localhost";
const depPath = path.join(root, "deployments", `${NETWORK}.json`);
if (!fs.existsSync(depPath)) {
  console.error(`No deployment at ${depPath}. Deploy first (npm run deploy:local).`);
  process.exit(1);
}

export const D = JSON.parse(fs.readFileSync(depPath, "utf8"));
export const ABI = JSON.parse(fs.readFileSync(path.join(root, "deployments", "abi.json"), "utf8"));
export const LOCAL = D.chainId === 31337;

const list = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);

export const config = {
  rpc: env.RPC_URL || D.rpc,
  tickMs: Number(env.TICK_MS || (LOCAL ? 2000 : 1000)),
  keeperMs: Number(env.KEEPER_MS || 5000),
  simulate: env.SIMULATE ? env.SIMULATE === "1" : LOCAL && D.oracleKind === "reporter",
  rfqPort: Number(env.RFQ_PORT || 8787),
  deployerKey: env.DEPLOYER_KEY || (LOCAL ? DEV_KEYS[0] : null),
  makerKeys: env.MAKER_KEYS ? list(env.MAKER_KEYS) : LOCAL ? DEV_KEYS.slice(1, 4) : [],
  operatorKey: env.OPERATOR_KEY || (LOCAL ? DEV_KEYS[4] : null),
  requoteBps: Number(env.REQUOTE_BPS || 100), // move threshold before a quote is repriced
  askSize: Number(env.ASK_SIZE || 25),
  bidSize: Number(env.BID_SIZE || 15),
  hermes: env.HERMES_URL || "https://hermes.pyth.network",
  pythIds: Object.fromEntries(list(env.PYTH_IDS).map((kv) => kv.split("="))),
};

export const KIND = { CALL: 0, PUT: 1, CALL_SPREAD: 2, PUT_SPREAD: 3 };
export const KIND_NAME = ["Upside", "Floor", "Capped Upside", "Budget Floor"];
