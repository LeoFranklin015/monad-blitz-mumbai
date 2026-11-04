import { ethers } from "ethers";

// Bound every log request, including requests made internally by ethers.
export class BoundedJsonRpcProvider extends ethers.JsonRpcProvider {
  async _perform(request) {
    if (request.method !== "getLogs") return super._perform(request);
    const filter = request.filter;
    const numeric = (value) => typeof value === "number" || (typeof value === "string" && /^(0x[\da-f]+|\d+)$/i.test(value));
    if (!numeric(filter.fromBlock)) return super._perform(request);
    let end = filter.toBlock;
    if (end === "latest") end = await super._perform({ method: "getBlockNumber" });
    if (!numeric(end)) return super._perform(request);
    const from = Number(filter.fromBlock), to = Number(end);
    const logs = [];
    for (let start = from; start <= to; start += 5000) {
      const result = await super._perform({ ...request, filter: {
        ...filter, fromBlock: ethers.toQuantity(start), toBlock: ethers.toQuantity(Math.min(start + 4999, to)),
      } });
      logs.push(...result);
    }
    return logs;
  }
}
