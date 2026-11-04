import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BoundedJsonRpcProvider } from "../src/lib/rpc.js";

test("log queries are paginated within the free RPC limit", async () => {
  const ranges = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const call = JSON.parse(body);
    let result;
    if (call.method === "eth_blockNumber") result = "0x19";
    else {
      assert.equal(call.method, "eth_getLogs");
      const { fromBlock, toBlock } = call.params[0];
      ranges.push([Number(fromBlock), Number(toBlock)]);
      result = [];
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const provider = new BoundedJsonRpcProvider(`http://127.0.0.1:${server.address().port}`, 10143, {
    staticNetwork: true, batchMaxCount: 1,
  });
  try {
    assert.deepEqual(await provider.getLogs({ fromBlock: 1, toBlock: "latest" }), []);
    assert.equal(ranges.length, 3);
    assert.deepEqual(ranges[0], [1, 10]);
    assert.deepEqual(ranges.at(-1), [21, 25]);
  } finally {
    provider.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
