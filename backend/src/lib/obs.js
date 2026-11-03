// Logging and metrics. Prometheus text format at GET /metrics.
import { config } from "../config.js";

export function log(...a) {
  const msg = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  if (config.logFormat === "json") {
    const level = msg.startsWith("!") ? "error" : "info";
    console.log(JSON.stringify({ t: new Date().toISOString(), level, msg: msg.replace(/^!\s*/, "") }));
  } else {
    console.log(new Date().toISOString().slice(11, 19), msg);
  }
}

const counters = new Map();
const gauges = new Map();
const beats = new Map(); // service -> last successful tick (ms)

const key = (name, labels) => name + (labels ? "{" + Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(",") + "}" : "");

export const metrics = {
  inc(name, labels, by = 1) {
    const k = key(name, labels);
    counters.set(k, (counters.get(k) || 0) + by);
  },
  set(name, labels, v) {
    gauges.set(key(name, labels), v);
  },
  beat(service) {
    beats.set(service, Date.now());
  },
  ages() {
    const now = Date.now();
    return Object.fromEntries([...beats].map(([s, t]) => [s, Math.round((now - t) / 1000)]));
  },
  text() {
    const now = Date.now();
    const lines = [];
    for (const [k, v] of counters) lines.push(`wo_${k} ${v}`);
    for (const [k, v] of gauges) lines.push(`wo_${k} ${v}`);
    for (const [s, t] of beats) lines.push(`wo_service_last_tick_seconds{service="${s}"} ${((now - t) / 1000).toFixed(1)}`);
    return lines.sort().join("\n") + "\n";
  },
};
