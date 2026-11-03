// Demo controls for the local chain: move the price feed and the clock so a whole weekend plays out in a minute.
import { ethers } from "ethers";
import { D, S, usd, isLocal } from "../chain.js";
import { devSigner } from "../wallet.js";
import { $, html, fmt, act } from "../ui.js";

export function demo(el, refreshAll) {
  if (!isLocal()) return;
  el.hidden = false;
  let wick = 11, monday = 6;

  const draw = () => {
    const st = S.stock;
    const spot = S.spots[st.address] || st.spot;
    const next = [...new Set(S.series.map((s) => s.expiry))].filter((e) => e > S.now).sort((a, b) => a - b)[0];
    el.innerHTML = html`<div class="between"><h3 style="margin:0">Demo controls</h3><button class="sm ghost" id="dMin">${el.classList.contains("min") ? "Open" : "Hide"}</button></div>
      <div class="body">
        <div class="note" style="margin-top:4px">Local chain only. Acts on ${st.symbol} (${fmt.usd(spot)}).</div>
        <label style="display:block;margin-top:10px"><span>Saturday wick: -${wick}%</span><input type="range" id="dW" min="1" max="35" value="${wick}" /></label>
        <div class="grid2"><button id="dWick">Wick</button><button id="dRec">Recover</button></div>
        <label style="display:block;margin-top:10px"><span>Monday open vs now: ${monday >= 0 ? "+" : ""}${monday}%</span><input type="range" id="dM" min="-20" max="20" value="${monday}" /></label>
        <button class="primary wide" id="dMon">Jump to ${next ? fmt.date(next) : "expiry"} and settle</button>
        <div class="note">Moves the chain clock past expiry and posts settlement prices. The keeper then settles, pays holders, rolls vaults and opens next week.</div>
      </div>`;
    $("#dMin", el).onclick = () => { el.classList.toggle("min"); draw(); };
    $("#dW", el).oninput = (e) => { wick = Number(e.target.value); $("label span", el).textContent = `Saturday wick: -${wick}%`; };
    $("#dM", el).oninput = (e) => { monday = Number(e.target.value); el.querySelectorAll("label span")[1].textContent = `Monday open vs now: ${monday >= 0 ? "+" : ""}${monday}%`; };
    $("#dWick", el).onclick = () => act("Wicking", () => push(st.address, spot * (1 - wick / 100)), refreshAll);
    $("#dRec", el).onclick = () => act("Recovering", () => push(st.address, st.spot), refreshAll);
    $("#dMon", el).onclick = () => act("Jumping to the open", () => jump(next, st, spot * (1 + monday / 100)), refreshAll);
  };

  async function push(asset, px) {
    const { signer } = await devSigner();
    const o = new ethers.Contract(D.oracle, ["function pushSpot(address,uint256)"], signer);
    await (await o.pushSpot(asset, usd(px))).wait();
  }

  async function jump(expiry, st, px) {
    if (!expiry) throw new Error("No live expiry");
    const { provider, signer } = await devSigner();
    const o = new ethers.Contract(D.oracle, ["function pushSample(address,uint64,uint256)", "function pushSpot(address,uint256)"], signer);
    const now = (await provider.getBlock("latest")).timestamp;
    if (now < expiry) {
      await provider.send("evm_setNextBlockTimestamp", [expiry + 1]);
      await provider.send("evm_mine", []);
    }
    for (const s of D.stocks) {
      const p = s === st ? px : S.spots[s.address] || s.spot;
      for (const d of [-0.002, 0, 0.002]) await (await o.pushSample(s.address, expiry, usd(p * (1 + d)))).wait();
      await (await o.pushSpot(s.address, usd(p))).wait();
    }
    await provider.send("evm_increaseTime", [D.settlementWindow + 5]);
    await provider.send("evm_mine", []);
  }

  draw();
  return { draw };
}
