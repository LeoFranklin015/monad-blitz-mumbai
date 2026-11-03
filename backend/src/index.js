// Runs the backend services. Pass names to run a subset:
//   node src/index.js                 everything
//   node src/index.js makers rfq      quoting only
//   node src/index.js keeper reporter
import { D, NETWORK, config } from "./config.js";
import { log } from "./lib/chain.js";
import { refreshMarket } from "./lib/market.js";
import { startMakers } from "./services/makers.js";
import { startRfq } from "./services/rfq.js";
import { startReporter } from "./services/reporter.js";
import { startKeeper } from "./services/keeper.js";

const want = new Set(process.argv.slice(2));
const on = (n) => want.size === 0 || want.has(n);

log(`network ${NETWORK} (chain ${D.chainId}) · protocol ${D.protocol}`);

function loop(name, ms, fn) {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      log(`${name}: ${e.shortMessage || e.message}`);
    } finally {
      running = false;
    }
  }, ms);
}

await refreshMarket();
const reporter = on("reporter") ? await startReporter() : null;
const makers = on("makers") ? await startMakers() : null;
if (on("rfq")) startRfq();
const keeper = on("keeper") ? await startKeeper() : null;

loop("market", Math.max(500, config.tickMs / 2), refreshMarket);
if (reporter) loop("reporter", config.tickMs, reporter.tick);
if (makers) loop("makers", config.tickMs, makers.tick);
if (keeper) loop("keeper", config.keeperMs, keeper.tick);
