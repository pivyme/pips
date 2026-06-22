#!/usr/bin/env bash
# Operator container entrypoint (see backend/Dockerfile). Prepares the box to republish itself after a
# devnet wipe, then runs the API. Two prep jobs the deploy-watch self-publish needs:
#   1. Write backend/.env from the container env, so scripts/devnet-refresh.sh (which the worker spawns
#      on a wipe) can read the operator key + DB url. The API itself reads process.env directly, so this
#      file exists purely for the recovery scripts.
#   2. Seed the sui CLI config + keystore NON-interactively, so the spawned publish never hits the CLI's
#      first-run "connect to a full node?" prompt and hangs forever in a container with no tty.
# Then exec the API as PID 1. The actual self-publish is driven by the deploy-watch worker
# (PIPS_SELF_PUBLISH=true); this script only lays the groundwork.
set -uo pipefail

ROOT="/app"
BACKEND="$ROOT/backend"
NET="${SUI_NETWORK:-devnet}"
RPC="${SUI_FULLNODE_URL:-https://fullnode.devnet.sui.io:443}"
SUI_CFG="${HOME:-/root}/.sui/sui_config"

# --- 1. backend/.env for the recovery scripts -------------------------------------------------------
if [ -n "${TESTING_WALLET_PK:-}" ]; then
  umask 077
  {
    echo "TESTING_WALLET_PK=${TESTING_WALLET_PK}"
    echo "DATABASE_URL=${DATABASE_URL:-}"
    echo "SUI_NETWORK=${NET}"
    echo "SUI_FULLNODE_URL=${RPC}"
    [ -n "${PIPS_DEPLOY_RPC:-}" ] && echo "PIPS_DEPLOY_RPC=${PIPS_DEPLOY_RPC}"
  } > "$BACKEND/.env"
  echo "[entrypoint] wrote $BACKEND/.env for the recovery scripts"
else
  echo "[entrypoint] WARNING: TESTING_WALLET_PK not set; self-publish will not work"
fi

# --- 2. seed the sui CLI config (idempotent, no prompt) ---------------------------------------------
if command -v sui >/dev/null 2>&1 && [ -n "${TESTING_WALLET_PK:-}" ]; then
  mkdir -p "$SUI_CFG"
  # keystore: importing the operator key creates ~/.sui/sui_config/sui.keystore (no-op if already there)
  sui keytool import "$TESTING_WALLET_PK" ed25519 >/dev/null 2>&1 || true
  # derive the operator address with the same code the scripts use, to pin active_address
  ADDR="$(cd "$BACKEND" && bun -e 'import {Ed25519Keypair} from "@mysten/sui/keypairs/ed25519"; import {decodeSuiPrivateKey} from "@mysten/sui/cryptography"; const {secretKey}=decodeSuiPrivateKey(process.env.TESTING_WALLET_PK); console.log(Ed25519Keypair.fromSecretKey(secretKey).getPublicKey().toSuiAddress())' 2>/dev/null || true)"
  # write client.yaml directly so the first `sui client` call never triggers the interactive setup
  if [ ! -f "$SUI_CFG/client.yaml" ]; then
    cat > "$SUI_CFG/client.yaml" <<YAML
---
keystore:
  File: $SUI_CFG/sui.keystore
envs:
  - alias: $NET
    rpc: "$RPC"
    ws: ~
    basic_auth: ~
active_env: $NET
active_address: "${ADDR:-~}"
YAML
    echo "[entrypoint] seeded sui client config ($NET -> $RPC, operator ${ADDR:-unknown})"
  fi
else
  echo "[entrypoint] sui CLI not found or no operator key; skipping CLI seed (self-publish disabled)"
fi

# --- 3. run the API as PID 1 ------------------------------------------------------------------------
cd "$BACKEND"
exec bun index.ts
