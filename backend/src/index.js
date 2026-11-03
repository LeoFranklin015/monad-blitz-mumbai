// Runs the backend services. Pass names to run a subset, one per process if you like:
//   node src/index.js                         everything
//   node src/index.js api makers hedger       quoting
//   node src/index.js keeper reporter         operations
// Services: api, makers, hedger, keeper, reporter. The market snapshot and indexer always run.
import { D, NETWORK, config } from "./config.js";
import { log } from "./lib/chain.js";
import { refreshMarket } from "./lib/market.js";
import { index, sync } from "./lib/indexer.js";
import { startMakers } from "./services/makers.js";
import { startHedger } from "./services/hedger.js";
import { startApi } from "./services/api.js";
import { startReporter } from "./services/reporter.js";
import { startKeeper } from "./services/keeper.js";

const ALL = ["api", "makers", "hedger", "keeper", "reporter"];
const args = process.argv.slice(2);
const want = new Set(args.length ? args : ALL);
for (const a of want) if (!ALL.includes(a)) throw new Error(`unknown service "${a}" (use ${ALL.join(", ")})`);
const on = (n) => want.has(n);

log(`network ${NETWORK} (chain ${D.chainId}) · protocol ${D.protocol} · services ${[...want].join(", ")}`);

const timers = [];
const inflight = new Set();
function loop(name, ms, fn) {
  let running = false;
  timers.push(
    setInterval(() => {
      if (running || stopping) return;
      running = true;
      const p = (async () => {
        try {
          await fn();
        } catch (e) {
          log(`! ${name}: ${e.shortMessage || e.message}`);
        } finally {
          running = false;
        }
      })();
      inflight.add(p);
      p.finally(() => inflight.delete(p));
    }, ms),
  );
}

index.load();
await sync();
await refreshMarket();

const reporter = on("reporter") ? await startReporter() : null;
const makers = on("makers") ? await startMakers() : null;
const hedger = on("hedger") && makers ? await startHedger(makers.makers) : null;
const server = on("api") ? startApi() : null;
const keeper = on("keeper") ? await startKeeper() : null;

loop("market", Math.max(500, config.tickMs / 2), refreshMarket);
loop("indexer", Math.max(2000, config.tickMs * 2), sync);
if (reporter) loop("reporter", config.tickMs, reporter.tick);
if (makers) loop("makers", config.tickMs, makers.tick);
if (hedger) loop("hedger", config.hedgerMs, hedger.tick);
if (keeper) loop("keeper", config.keeperMs, keeper.tick);

let stopping = false;
async function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  log(`${sig}: shutting down`);
  timers.forEach(clearInterval);
  server?.close();
  const force = setTimeout(() => process.exit(1), 90_000);
  try {
    await Promise.allSettled([...inflight]); // let in-flight ticks finish so nothing posts after the sweep
    if (makers) await makers.cancelAll(); // never leave quotes on the book unattended
  } catch (e) {
    log(`! shutdown: ${e.message}`);
  }
  clearTimeout(force);
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (e) => log(`! unhandled: ${e?.message || e}`));
