#!/usr/bin/env bash
# Pips localnet: run the whole DeepBook Predict stack on a local Sui node with infinite SUI.
#
# Testnet is gas-starved (oracle creation is storage-heavy and the faucet is rate limited),
# so this stands up a private local chain instead. Two terminals:
#
#   Terminal 1:  scripts/localnet.sh up          # starts the node + faucet, leave it running
#   Terminal 2:  scripts/localnet.sh bootstrap    # publishes + seeds Predict, points the apps at it
#
# Then run the apps as usual (their .env now points at localnet):
#   cd backend && bun dev
#   cd web && bun dev
#
# `up` uses --force-regenesis, so every run is a fresh chain. Re-run `bootstrap` after each
# `up`; it republishes and rewrites deployed.json + the .env ids.
#
# Remote node: to bootstrap against a node you deployed elsewhere (e.g. our box at
# rpc.playpips.fun), skip `up` and point the bootstrap at it:
#   PIPS_LOCALNET_RPC=https://rpc.playpips.fun scripts/localnet.sh bootstrap
# Two requirements the bootstrap can't fix for you: the node needs a real TLS cert (the sui CLI
# and Bun both reject a Traefik default self-signed cert), and a reachable faucet OR an operator
# wallet pre-funded with SUI (the bootstrap's faucet call defaults to localhost:9123).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Default to the local node; override to bootstrap a remote deployed localnet.
RPC="${PIPS_LOCALNET_RPC:-http://127.0.0.1:9000}"

require_sui() {
  command -v sui >/dev/null 2>&1 || {
    echo "error: the 'sui' CLI is not installed. Install it: https://docs.sui.io/guides/developer/getting-started/sui-install" >&2
    exit 1
  }
}

case "${1:-help}" in
  up)
    require_sui
    echo "Starting a fresh local Sui node + faucet (force-regenesis)."
    echo "Leave this running. In another terminal: scripts/localnet.sh bootstrap"
    echo
    exec sui start --with-faucet --force-regenesis
    ;;

  bootstrap)
    require_sui
    echo "Waiting for the node at $RPC ..."
    up=false
    for _ in $(seq 1 60); do
      # -k so a self-signed remote cert still passes the reachability probe (publish still needs a real cert).
      if curl -skf -o /dev/null -X POST "$RPC" -H 'content-type: application/json' \
        -d '{"jsonrpc":"2.0","id":1,"method":"sui_getChainIdentifier","params":[]}'; then
        up=true
        break
      fi
      sleep 1
    done
    if [ "$up" != true ]; then
      echo "error: node never came up at $RPC. Start it (scripts/localnet.sh up) or set PIPS_LOCALNET_RPC." >&2
      exit 1
    fi
    echo "Node is up. Publishing + seeding Predict on localnet ($RPC)..."
    # The bootstrap publishes + seeds, writes deployed.localnet.json + the .env ids, and
    # restores the ephemeral publish artifacts it touched in contracts/ so git stays clean.
    ( cd "$ROOT/backend" && SUI_NETWORK=localnet SUI_FULLNODE_URL="$RPC" bun run bootstrap --force )

    # Point the web app at the real local chain for this device (off demo mode). The
    # bootstrap already wrote VITE_SUI_NETWORK + the ids; this just flips the sim off.
    web_env="$ROOT/web/.env"
    if [ -f "$web_env" ] && grep -q '^VITE_DEMO_MODE=' "$web_env"; then
      perl -0pi -e 's/^VITE_DEMO_MODE=.*$/VITE_DEMO_MODE="false"/m' "$web_env"
      echo "Set VITE_DEMO_MODE=false in web/.env (play against the local chain)."
    fi

    echo
    echo "Localnet is ready. Start the apps:"
    echo "  cd backend && bun dev      # :3700 (SUI_NETWORK=localnet)"
    echo "  cd web && bun dev          # :3200 (VITE_SUI_NETWORK=localnet)"
    echo
    echo "The operator worker pushes real Pyth prices onto the local oracles, so plays settle"
    echo "exactly like testnet, just with infinite local SUI."
    ;;

  *)
    echo "Pips localnet"
    echo
    echo "Usage: scripts/localnet.sh <command>"
    echo "  up         start a fresh local Sui node + faucet (run in its own terminal)"
    echo "  bootstrap  publish + seed Predict on the running local node, point the apps at it"
    ;;
esac
