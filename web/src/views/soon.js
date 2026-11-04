// Placeholder for products that aren't in the demo yet (Earn, Protect). The demo runs in Pro.
import { html } from "../ui.js";

export function soon({ name, line, detail }) {
  return (root) => ({
    async render() {
      root.className = "";
      root.innerHTML = html`<section class="soon">
        <div class="soon__tag">Coming soon</div>
        <h1 class="soon__title">${name}</h1>
        <p class="soon__line">${line}</p>
        <p class="soon__detail">${detail}</p>
        <div class="soon__live"><span class="soon__dot" aria-hidden="true"></span>Upside and Floor are live now on Monad testnet.</div>
        <a class="soon__cta" href="#pro">Launch Pro</a>
      </section>`;
    },
  });
}
