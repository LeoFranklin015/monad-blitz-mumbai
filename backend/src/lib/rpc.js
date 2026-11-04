import { ethers } from "ethers";

// Bound every log request, including requests made internally by ethers.
export class BoundedJsonRpcProvider extends ethers.JsonRpcProvider {
  constructor(url, network, options, maxLogRange = 10, logDelayMs = 125) {
    super(url, network, options);
    this.maxLogRange = maxLogRange;
    this.logDelayMs = logDelayMs;
  }

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
    for (let start = from; start <= to; start += this.maxLogRange) {
      if (logs.length && this.logDelayMs) await new Promise((resolve) => setTimeout(resolve, this.logDelayMs));
      const result = await super._perform({ ...request, filter: {
        ...filter,
        fromBlock: ethers.toQuantity(start),
        toBlock: ethers.toQuantity(Math.min(start + this.maxLogRange - 1, to)),
      } });
      logs.push(...result);
    }
    return logs;
  }
}
