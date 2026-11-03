#!/usr/bin/env bash
# Boots a dev chain, deploys, runs the backend, and checks the API reports live quotes.
# Usage: bash backend/scripts/smoke.sh   (from the repo root)
set -euo pipefail
cd "$(dirname "$0")/../.."
LOG=${SMOKE_LOG:-/tmp/weekend-options-smoke}
mkdir -p "$LOG"
export DATA_DIR="$LOG/data"
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT

npm run chain >"$LOG/chain.log" 2>&1 & pids+=($!)
for i in $(seq 60); do
  curl -sf -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' http://127.0.0.1:8545 >/dev/null && break
  sleep 1
done
EXPIRY_MINUTES=4320 npm run deploy:local >"$LOG/deploy.log" 2>&1 || { tail -40 "$LOG/deploy.log"; exit 1; }

npm run backend >"$LOG/backend.log" 2>&1 & pids+=($!)
for i in $(seq 90); do
  q=$(curl -sf http://127.0.0.1:8787/status 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).liveQuotes||0)}catch{console.log(0)}})' || true)
  q=$(echo "${q:-0}" | tail -1)
  if [ "${q:-0}" -gt 0 ]; then
    curl -sf http://127.0.0.1:8787/health >/dev/null
    curl -sf http://127.0.0.1:8787/markets | head -c 200; echo
    echo "smoke ok: $q live quotes"
    exit 0
  fi
  sleep 2
done
echo "smoke failed: no live quotes"; tail -60 "$LOG/backend.log"; exit 1
