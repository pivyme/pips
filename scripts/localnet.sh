#!/usr/bin/env bash
# PIPS localnet + DeepBook Predict deploy tool.
#
# Stands up / points the apps at a Sui localnet and deploys our OWN Predict instance end to
# end: DUSDC + token + deepbook + predict, the vault seed, a live BTC oracle, the mint/redeem
# round trip, and writes every id (+ the RPC url) into backend/.env and web/.env. Works against
# a node you deployed elsewhere (the default, our box) OR a throwaway local node.
#
# Common case (deployed node):
#   scripts/localnet.sh setup            # one shot: import key, deploy Predict, wire both .envs
#   cd backend && bun dev                # API  :3780
#   cd web && bun dev                    # web  :3200
#
# Throwaway local node instead:
#   Terminal 1:  scripts/localnet.sh up                                   # starts node + faucet
#   Terminal 2:  PIPS_LOCALNET_RPC=http://127.0.0.1:9000 scripts/localnet.sh setup
#
# After you edit a Move package:  scripts/localnet.sh redeploy   (republish + reseed, new ids)
# See what's live:                scripts/localnet.sh status     (full check: doctor)
#
# Adding a game or editing the UI/backend needs NO redeploy: the three games compose the two
# Predict instruments, so just restart `bun dev`. Only Move (contracts/) changes need redeploy.
#
# DEPLOY NEEDS gRPC: the sui CLI (1.71+) publishes over gRPC, not JSON-RPC. A Cloudflare-fronted
# node 403s gRPC while passing JSON-RPC, so the backend + browser run fine against the proxied
# url but the CLI can't publish through it. setup/redeploy handle this automatically: they
# publish through a gRPC-reachable url (the node's origin IP on :9000, auto-detected, or
# PIPS_DEPLOY_RPC if you set one) and then point the apps back at the proxied runtime url. So
# `setup`/`redeploy` are one command even behind Cloudflare. `doctor` shows the resolved path.
#
# Runtime node = PIPS_LOCALNET_RPC > backend/.env SUI_FULLNODE_URL > http://127.0.0.1:9000
# Deploy node  = PIPS_DEPLOY_RPC > (auto: origin IP :9000 if runtime gRPC is blocked) > runtime

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
DEPLOYED="$BACKEND/src/lib/sui/deployed.localnet.json"

# ---- helpers ---------------------------------------------------------------

c_bold=$'\033[1m'; c_dim=$'\033[2m'; c_red=$'\033[31m'; c_grn=$'\033[32m'; c_yel=$'\033[33m'; c_rst=$'\033[0m'
ok()   { echo "  ${c_grn}ok${c_rst}   $*"; }
warn() { echo "  ${c_yel}warn${c_rst} $*"; }
fail() { echo "  ${c_red}fail${c_rst} $*"; }
die()  { echo "${c_red}error:${c_rst} $*" >&2; exit 1; }

require() { command -v "$1" >/dev/null 2>&1 || die "the '$1' CLI is not installed. $2"; }

# Resolve the target RPC once. Override > backend/.env > local default.
resolve_rpc() {
  if [ -n "${PIPS_LOCALNET_RPC:-}" ]; then echo "$PIPS_LOCALNET_RPC"; return; fi
  local fromenv=""
  [ -f "$BACKEND/.env" ] && fromenv="$(grep -E '^SUI_FULLNODE_URL=' "$BACKEND/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  echo "${fromenv:-http://127.0.0.1:9000}"
}

# JSON-RPC at an explicit url. Strict TLS on purpose: if the cert is bad here, the browser breaks too.
rpc_at() {
  curl -s --max-time 15 -X POST "$1" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":${3:-[]}}" 2>/dev/null || true
}
rpc() { rpc_at "$RPC" "$1" "${2:-[]}"; }

chain_id_at() { rpc_at "$1" sui_getChainIdentifier | grep -oE '"result":"[^"]*"' | sed -E 's/.*:"([^"]*)"/\1/'; }
chain_id()    { chain_id_at "$RPC"; }
# pull a "key":"value" string field from deployed.localnet.json
dfield() { [ -f "$DEPLOYED" ] && grep -oE "\"$1\"[ ]*:[ ]*\"[^\"]*\"" "$DEPLOYED" | head -1 | sed -E 's/.*: *"([^"]*)"/\1/'; }

operator_pk()   { grep -E '^TESTING_WALLET_PK=' "$BACKEND/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }
operator_addr() {
  ( cd "$BACKEND" && bun -e 'import {Ed25519Keypair} from "@mysten/sui/keypairs/ed25519"; import {decodeSuiPrivateKey} from "@mysten/sui/cryptography"; const {secretKey}=decodeSuiPrivateKey(process.env.TESTING_WALLET_PK); console.log(Ed25519Keypair.fromSecretKey(secretKey).getPublicKey().toSuiAddress())' 2>/dev/null )
}

# Point the sui CLI at the operator key (the CLI signs the publish). Idempotent.
import_operator_key() {
  local pk addr
  pk="$(operator_pk)"; [ -n "$pk" ] || die "TESTING_WALLET_PK is empty in backend/.env"
  addr="$(operator_addr)"; [ -n "$addr" ] || die "could not derive the operator address (is backend bun set up?)"
  sui keytool import "$pk" ed25519 >/dev/null 2>&1 || true   # no-op if already imported
  sui client switch --address "$addr" >/dev/null 2>&1 || true
  echo "$addr"
}

wait_for_node() {
  echo "Waiting for the node at $RPC ..."
  for _ in $(seq 1 60); do [ -n "$(chain_id)" ] && return 0; sleep 1; done
  die "node never answered at $RPC. Start it (scripts/localnet.sh up) or set PIPS_LOCALNET_RPC."
}

# The sui CLI publishes over gRPC. Returns the gRPC ping status for a url (h2c for http, h2 for https).
grpc_status() {
  local h2=--http2; case "$1" in http://*) h2=--http2-prior-knowledge;; esac
  curl -s -o /dev/null -w "%{http_code}" $h2 --max-time 8 \
    -X POST "$1/sui.rpc.v2.LedgerService/GetServiceInfo" -H 'content-type: application/grpc' 2>/dev/null || echo 000
}
grpc_ok()      { [ "$(grpc_status "$1")" = "200" ]; }
grpc_blocked() { [ "$(grpc_status "${1:-$RPC}")" = "403" ]; }

# The url to publish through. Explicit override, then backend/.env (a CDN hides the origin from
# DNS, so it's recorded there), then auto-detect: runtime if its gRPC is open, else origin :9000.
resolve_deploy_rpc() {
  if [ -n "${PIPS_DEPLOY_RPC:-}" ]; then echo "$PIPS_DEPLOY_RPC"; return 0; fi
  local fromenv=""
  [ -f "$BACKEND/.env" ] && fromenv="$(grep -E '^PIPS_DEPLOY_RPC=' "$BACKEND/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  if [ -n "$fromenv" ]; then echo "$fromenv"; return 0; fi
  derive_deploy_rpc
}

# Auto-detect a gRPC-reachable url: the runtime url if its gRPC is open, else the node's origin
# IP on :9000 (the raw Sui node serves gRPC there). Fails for a CDN-proxied host that hides its IP.
derive_deploy_rpc() {
  if grpc_ok "$RPC"; then echo "$RPC"; return 0; fi
  local host ip cand
  host=$(echo "$RPC" | sed -E 's#^[a-z]+://([^/:]+).*#\1#')
  ip=$(dig +short "$host" 2>/dev/null | grep -E '^[0-9.]+$' | tail -1)
  [ -n "$ip" ] || return 1
  cand="http://$ip:9000"
  if grpc_ok "$cand" && [ -n "$(chain_id_at "$cand")" ] && [ "$(chain_id_at "$cand")" = "$(chain_id_at "$RPC")" ]; then
    echo "$cand"; return 0
  fi
  return 1
}

# Make a sui CLI env for this rpc so the bootstrap reuses it (its own new-env hits a buggy gRPC
# health probe). The env persists even when that probe errors, which is all the bootstrap needs.
ensure_cli_env() {
  sui client envs --json 2>/dev/null | grep -q "\"$1\"" && return 0
  local alias; alias="pips-$(echo "$1" | tr -cs 'a-zA-Z0-9' '-' | sed 's/^-//; s/-*$//')"
  sui client new-env --alias "$alias" --rpc "$1" >/dev/null 2>&1 || true
}

# Point both apps at a url for runtime (reads/plays over JSON-RPC). web keeps quotes.
set_runtime_rpc() {
  ( cd "$BACKEND" && URL="$1" bun -e '
    import fs from "fs";
    const set = (p, k, v) => { if (!fs.existsSync(p)) return; let e = fs.readFileSync(p, "utf8");
      const re = new RegExp("^" + k + "=.*$", "m"); e = re.test(e) ? e.replace(re, k + "=" + v) : e + "\n" + k + "=" + v; fs.writeFileSync(p, e); };
    set(".env", "SUI_FULLNODE_URL", process.env.URL);
    set("../web/.env", "VITE_SUI_FULLNODE_URL", "\"" + process.env.URL + "\"");
  ' )
}

run_bootstrap() { # $1 = deploy rpc, $2 = "force" | ""
  local force=""; [ "${2:-}" = "force" ] && force="--force"
  echo "${c_bold}Deploying Predict via $1 ...${c_rst}"
  ( cd "$BACKEND" && SUI_NETWORK=localnet SUI_FULLNODE_URL="$1" bun run bootstrap $force )
}

# ---- commands --------------------------------------------------------------

cmd_setup() {
  require sui "Install it: https://docs.sui.io/guides/developer/getting-started/sui-install"
  require bun "Install it: https://bun.sh"
  echo "${c_bold}PIPS setup${c_rst}  runtime node: $RPC"
  wait_for_node
  local deploy; deploy="$(resolve_deploy_rpc || true)"
  if [ -z "$deploy" ]; then
    die "no gRPC-reachable url to publish through. The CLI deploys over gRPC; $RPC blocks it and no origin :9000 was found. Set PIPS_DEPLOY_RPC to a gRPC-reachable url, or run setup on the box."
  fi
  [ "$deploy" != "$RPC" ] && echo "Publishing via gRPC-reachable $deploy (apps stay on $RPC)."
  ensure_cli_env "$deploy"
  local addr; addr="$(import_operator_key)"
  echo "Operator: $addr (sui CLI active)"
  run_bootstrap "$deploy" "${1:-}"
  set_runtime_rpc "$RPC"   # the bootstrap wrote the deploy url; point the apps at the runtime url
  echo
  echo "${c_grn}Done.${c_rst} Predict is live and both .env files point the apps at $RPC. Now run:"
  echo "  cd backend && bun dev      # :3780"
  echo "  cd web && bun dev          # :3200"
  echo "  open http://localhost:3200/tools/wallet   # balances / send funds on this node"
}

cmd_redeploy() {
  echo "${c_bold}Redeploy${c_rst} (republish all Move packages + reseed, ids change)."
  cmd_setup force
}

cmd_apply_ids() {
  local f="${1:-}"
  { [ -n "$f" ] && [ -f "$f" ]; } || die "usage: scripts/localnet.sh apply-ids <deployed.localnet.json copied from the deploy machine>"
  local src; src="$(cd "$(dirname "$f")" && pwd)/$(basename "$f")"
  ( cd "$BACKEND" && SRC="$src" bun -e '
    import fs from "fs";
    const d = JSON.parse(fs.readFileSync(process.env.SRC, "utf8"));
    if (d.network !== "localnet") throw new Error("not a localnet deployment (network=" + d.network + ")");
    fs.writeFileSync("src/lib/sui/deployed.localnet.json", JSON.stringify(d, null, 2) + "\n");
    const setEnv = (p, vars) => { if (!fs.existsSync(p)) return; let e = fs.readFileSync(p, "utf8");
      for (const [k, v] of Object.entries(vars)) { const re = new RegExp("^" + k + "=.*$", "m"); e = re.test(e) ? e.replace(re, k + "=" + v) : e + "\n" + k + "=" + v; }
      fs.writeFileSync(p, e); };
    setEnv(".env", { SUI_NETWORK: "localnet", PREDICT_PACKAGE_ID: d.packageId, PREDICT_REGISTRY_ID: d.registryId, PREDICT_OBJECT_ID: d.predictId, PREDICT_ADMIN_CAP_ID: d.adminCapId });
    setEnv("../web/.env", { VITE_SUI_NETWORK: "localnet", VITE_PREDICT_PACKAGE_ID: d.packageId, VITE_PREDICT_OBJECT_ID: d.predictId, VITE_DUSDC_TYPE: d.dusdc.type });
    console.log("applied package " + d.packageId);
  ' )
  ok "ids wired into deployed.localnet.json + both .env files"
  echo "  (kept your VITE_SUI_FULLNODE_URL so the browser still uses the proxied url)"
}

cmd_up() {
  require sui "Install it: https://docs.sui.io/guides/developer/getting-started/sui-install"
  echo "Starting a fresh local Sui node + faucet (force-regenesis). Leave this running."
  echo "Then, in another terminal: PIPS_LOCALNET_RPC=http://127.0.0.1:9000 scripts/localnet.sh setup"
  echo
  exec sui start --with-faucet --force-regenesis
}

cmd_status() {
  echo "${c_bold}PIPS localnet status${c_rst}"
  echo "  target RPC   $RPC"
  local live; live="$(chain_id)"
  if [ -z "$live" ]; then fail "node unreachable at $RPC"; return; fi
  ok "node reachable, chain $live"
  if [ -f "$DEPLOYED" ]; then
    local pkg pre; pkg="$(dfield packageId)"; pre="$(dfield bootstrappedAt)"
    echo "  deployed.localnet.json: package $pkg ${c_dim}(at $pre)${c_rst}"
    local obj; obj="$(rpc sui_getObject "[\"$pkg\",{\"showType\":true}]")"
    if echo "$obj" | grep -q '"notExists"'; then
      fail "that package is NOT on the live chain (regenesis?). Run: scripts/localnet.sh redeploy"
    else
      ok "Predict package is live on this chain"
    fi
  else
    warn "no deployed.localnet.json yet. Run: scripts/localnet.sh setup"
  fi
  local addr bal; addr="$(operator_addr)"
  bal="$(rpc suix_getBalance "[\"$addr\"]" | grep -oE '"totalBalance":"[0-9]*"' | sed -E 's/.*:"([0-9]*)"/\1/')"
  [ -n "$bal" ] && echo "  operator     $addr  ${c_dim}($((bal/1000000000)) SUI)${c_rst}"
}

cmd_doctor() {
  echo "${c_bold}PIPS doctor${c_rst}  target node: $RPC"
  command -v sui >/dev/null 2>&1 && ok "sui CLI $(sui --version 2>/dev/null | awk '{print $2}')" || fail "sui CLI missing"
  command -v bun >/dev/null 2>&1 && ok "bun $(bun --version 2>/dev/null)" || fail "bun missing"

  local live; live="$(chain_id)"
  if [ -n "$live" ]; then ok "node reachable, chain $live"; else fail "node unreachable at $RPC (cert? down?)"; fi
  # cert: does STRICT https validate (what the browser needs)?
  case "$RPC" in
    https://*)
      if curl -s --max-time 10 -o /dev/null "$RPC" 2>/dev/null; then ok "TLS cert valid (browser can reach it)"
      elif curl -sk --max-time 10 -o /dev/null "$RPC" 2>/dev/null; then fail "self-signed cert: backend works but the BROWSER will reject it. Give the host a real cert (Cloudflare/Let's Encrypt)."
      fi ;;
  esac
  # gRPC decides whether the CLI can publish here (apps only need JSON-RPC, which works regardless).
  if [ -n "$live" ]; then
    if grpc_ok "$RPC"; then ok "gRPC open here (CLI can publish directly)"
    else
      local d; d="$(resolve_deploy_rpc || true)"
      if [ -n "$d" ]; then ok "gRPC blocked here (fine for running); setup/redeploy publish via $d"
      else warn "gRPC blocked and no origin :9000 found; set PIPS_DEPLOY_RPC to a gRPC url to (re)deploy"; fi
    fi
  fi

  local addr active; addr="$(operator_addr)"
  active="$(sui client active-address 2>/dev/null || true)"
  if [ "$active" = "$addr" ]; then ok "sui CLI active address is the operator"
  else warn "sui CLI active address ($active) != operator ($addr). 'setup' fixes this."; fi

  if [ -f "$DEPLOYED" ]; then
    local pkg dnet; pkg="$(dfield packageId)"; dnet="$(dfield network)"
    [ "$dnet" = "localnet" ] && ok "deployed.localnet.json present (network=$dnet)" || warn "deployed file network=$dnet"
    if [ -n "$live" ]; then
      if rpc sui_getObject "[\"$pkg\",{\"showType\":true}]" | grep -q '"notExists"'; then
        fail "Predict package not on the live chain. Run: scripts/localnet.sh redeploy"
      else ok "Predict package $pkg is live"; fi
    fi
  else warn "not deployed yet. Run: scripts/localnet.sh setup"; fi

  local bal; bal="$(rpc suix_getBalance "[\"$addr\"]" | grep -oE '"totalBalance":"[0-9]*"' | sed -E 's/.*:"([0-9]*)"/\1/')"
  if [ -n "$bal" ]; then
    if [ "$bal" -ge 1200000000 ]; then ok "operator funded ($((bal/1000000000)) SUI)"
    else fail "operator low on SUI ($bal MIST). Fund $addr on this chain (genesis alloc or faucet)."; fi
  fi
}

RPC="$(resolve_rpc)"

case "${1:-help}" in
  setup)    cmd_setup ;;
  redeploy) cmd_redeploy ;;
  bootstrap) shift; run_bootstrap "${PIPS_DEPLOY_RPC:-$RPC}" "${1:-}" ;;   # low-level: bootstrap [force]
  apply-ids) shift; cmd_apply_ids "${1:-}" ;;
  up)       cmd_up ;;
  status)   cmd_status ;;
  doctor)   cmd_doctor ;;
  *)
    echo "PIPS localnet + Predict deploy"
    echo
    echo "Usage: scripts/localnet.sh <command>   (target node: $RPC)"
    echo "  setup        one shot: import key, deploy Predict, wire both .env files"
    echo "  redeploy     republish all Move packages + reseed (after a contracts/ change)"
    echo "  apply-ids F  wire ids from a deployed.localnet.json deployed on another machine"
    echo "  status       quick check of what's live on the target node"
    echo "  doctor       full diagnose (deps, node, cert, gRPC, CLI key, deploy, funding)"
    echo "  up           start a throwaway LOCAL node + faucet (for the local-node flow)"
    echo
    echo "Target node = PIPS_LOCALNET_RPC > backend/.env SUI_FULLNODE_URL > http://127.0.0.1:9000"
    ;;
esac
