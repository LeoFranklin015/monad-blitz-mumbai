// Print each Kuru xStock market's bid, ask and mid, read from the chain the way the reporter does.
//   node backend/scripts/kuru-prices.mjs                  (Monad testnet)
//   RPC_URL=.. KURU_MARKETS="NVDAx=0x..,.." node backend/scripts/kuru-prices.mjs
import { ethers } from "ethers";
import { kuruBook } from "../src/lib/kuruBook.js";

const rpc = process.env.RPC_URL || "https://testnet-rpc.monad.xyz";
const markets = process.env.KURU_MARKETS
  ? Object.fromEntries(process.env.KURU_MARKETS.split(",").map((kv) => kv.split("=").map((x) => x.trim())))
  : {
      NVDAx: "0xE9C2B9E0F296dbeC9dcc3C8F0F64928F2F8bC081",
      TSLAx: "0x7A53BB8d8A8765418FfE331A02BF5984264922AA",
      SPYx: "0x185Af307dAfd968033337A0180E66B920B4b05Ca",
    };

const provider = new ethers.JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 }); // Monad testnet RPC rejects batches
for (const [symbol, market] of Object.entries(markets)) {
  const b = await kuruBook(provider, market);
  if (!b) console.log(`${symbol.padEnd(6)} one side of the book is empty`);
  else console.log(`${symbol.padEnd(6)} bid $${b.bid.toFixed(2)}  ask $${b.ask.toFixed(2)}  mid $${b.mid.toFixed(2)}  spread ${(((b.ask - b.bid) / b.mid) * 100).toFixed(2)}%`);
}
