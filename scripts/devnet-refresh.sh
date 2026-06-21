#!/usr/bin/env bash
# PIPS devnet refresh. One command: deploy the WHOLE Predict stack to Sui DEVNET, wire both
# .env files at devnet, reset backend state (re-arm users + wipe history), and print the env to
# paste into the deployed (Dokploy) box so it runs as the devnet operator.
#
# Why devnet: our self-hosted localnet node kept dying (RAM bloat -> RocksDB corruption). Devnet
# is Mysten-run and stable, and its faucet hands out 10 SUI per hit, so the "we need a fuckton of
# SUI for oracles" problem is gone without us babysitting a node. Same Predict code, public chain.
#
# Run it LOCALLY from the repo (it publishes with your sui CLI + funds the operator from the faucet):
#   scripts/devnet-refresh.sh            # interactive menu
#   scripts/devnet-refresh.sh all        # guided full run (preflight -> verify), confirms each step
#
#   or one phase at a time:
#   scripts/devnet-refresh.sh preflight  # deps + sui CLI devnet env + import operator key + switch
#   scripts/devnet-refresh.sh fund       # faucet-loop the operator to PIPS_DEVNET_FUND_SUI
#   scripts/devnet-refresh.sh deploy     # publish DUSDC + predict(+deepbook+token), seed, round-trip
#   scripts/devnet-refresh.sh wire       # point both .envs at devnet (network + RPC + frugal funding)
#   scripts/devnet-refresh.sh reset      # re-arm users + wipe play history (fresh slate)
#   scripts/devnet-refresh.sh dokploy    # print the operator env block to paste into the deployed box
#   scripts/devnet-refresh.sh verify     # chain id + package live + operator funded
#
# OPERATOR: the DEPLOYED box (Dokploy) is the devnet operator (it runs price-push / oracle-roll /
# settle). This machine stays a FOLLOWER (PIPS_OPERATOR_ENABLED=false), so the two never double-push.
# The `dokploy` phase prints exactly what to set on the deployed backend.
#
# Heads up: Sui devnet is wiped roughly weekly. When that happens our packages vanish and every
# play breaks. Just re-run this script: it republishes fresh and re-arms everything.
#
# Override via env: PIPS_DEVNET_RPC, PIPS_DEVNET_FAUCET, PIPS_DEVNET_FUND_SUI.

set -uo pipefail   # NOT -e: this is a wizard, it handles its own failures and keeps going.

# ---- config (override via env) ---------------------------------------------
RPC="${PIPS_DEVNET_RPC:-https://fullnode.devnet.sui.io:443}"
FAUCET="${PIPS_DEVNET_FAUCET:-https://faucet.devnet.sui.io/v2/gas}"
FUND_SUI="${PIPS_DEVNET_FUND_SUI:-60}"        # operator target: covers deploy + seeding the 3 ops wallets
CLI_ENV="devnet"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
WEB="$ROOT/web"
CONTRACTS="$ROOT/contracts"
DEPLOYED="$BACKEND/src/lib/sui/deployed.devnet.json"

# Funding knobs the operator (deployed box) uses to seed sponsor/settlement/treasury from its own
# SUI. Sized for a richly funded operator (you send it a few hundred+ SUI, see the address below);
# the devnet-faucet worker is the backstop if it ever runs low. The localnet defaults (topups of
# 500) are dialled to ~200 so they're comfortable but still faucet-recoverable after a devnet wipe.
FUND_KNOBS=(
  "PIPS_SPONSOR_MIN_SUI=50"
  "PIPS_SPONSOR_TOPUP_SUI=200"
  "PIPS_SETTLEMENT_MIN_SUI=50"
  "PIPS_SETTLEMENT_TOPUP_SUI=200"
  "PIPS_TREASURY_MIN_SUI=20"
  "PIPS_TREASURY_TOPUP_SUI=100"
  "PIPS_GAS_FUND_SUI=2"
  "PIPS_GAS_MIN_SUI=0.6"
)

# ---- pretty ----------------------------------------------------------------
b=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; grn=$'\033[32m'; yel=$'\033[33m'; cyn=$'\033[36m'; rst=$'\033[0m'
ok()    { echo "  ${grn}ok${rst}   $*"; }
warn()  { echo "  ${yel}warn${rst} $*"; }
fail()  { echo "  ${red}fail${rst} $*"; }
info()  { echo "  ${dim}$*${rst}"; }
step()  { echo; echo "${b}${cyn}== $* ==${rst}"; }
die()   { echo "${red}error:${rst} $*" >&2; exit 1; }

ask()     { local p="$1" a=""; read -r -p "$p" a </dev/tty || true; echo "$a"; }
confirm() { case "$(ask "$1 [y/N] ")" in y|Y|yes|YES) return 0;; *) return 1;; esac; }
confirm_word() { [ "$(ask "$2 (type ${b}$1${rst} to confirm): ")" = "$1" ]; }
pause()   { ask "$1 (press Enter to continue) " >/dev/null; }

require() { command -v "$1" >/dev/null 2>&1 || die "the '$1' CLI is not installed. $2"; }

# ---- rpc / faucet helpers --------------------------------------------------
jrpc() { curl -s --max-time 20 -X POST "$RPC" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}" 2>/dev/null || true; }
chain_id() { jrpc sui_getChainIdentifier | grep -oE '"result":"[^"]*"' | sed -E 's/.*:"([^"]*)"/\1/'; }
sui_mist() { jrpc suix_getBalance "[\"$1\"]" | grep -oE '"totalBalance":"[0-9]+"' | head -1 | sed -E 's/.*:"([0-9]+)"/\1/'; }
# value of a top-level "key":"string" in the deployed file (first match)
dfield()   { [ -f "$DEPLOYED" ] && grep -oE "\"$1\"[ ]*:[ ]*\"[^\"]*\"" "$DEPLOYED" | head -1 | sed -E 's/.*: *"([^"]*)"/\1/'; }

# Bun auto-loads backend/.env in cwd, so this derives the operator from TESTING_WALLET_PK there.
operator_addr() {
  ( cd "$BACKEND" && bun -e 'import {Ed25519Keypair} from "@mysten/sui/keypairs/ed25519"; import {decodeSuiPrivateKey} from "@mysten/sui/cryptography"; const pk=process.env.TESTING_WALLET_PK; if(!pk) process.exit(1); const {secretKey}=decodeSuiPrivateKey(pk); console.log(Ed25519Keypair.fromSecretKey(secretKey).getPublicKey().toSuiAddress())' 2>/dev/null )
}
operator_pk() { grep -E '^TESTING_WALLET_PK=' "$BACKEND/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }

# Update-or-append KEY=VALUE lines in a .env file. Values may hold :, /, :: (we split on the first =).
set_env() {
  local file="$1"; shift
  [ -f "$file" ] || { warn "no $file, skipping"; return 0; }
  local pairs=""; local kv; for kv in "$@"; do pairs+="$kv"$'\n'; done
  FILE="$file" PAIRS="$pairs" bun -e '
    import fs from "fs";
    const file = process.env.FILE;
    let e = fs.readFileSync(file, "utf8");
    for (const line of (process.env.PAIRS || "").split("\n")) {
      if (!line) continue;
      const i = line.indexOf("="); if (i < 0) continue;
      const k = line.slice(0, i), v = line.slice(i + 1);
      const re = new RegExp("^" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=.*$", "m");
      e = re.test(e) ? e.replace(re, () => k + "=" + v) : (e.endsWith("\n") ? e : e + "\n") + k + "=" + v + "\n";
    }
    fs.writeFileSync(file, e);
  '
}

# ===========================================================================
# Phase: preflight (deps + point the sui CLI at devnet + the operator key)
# ===========================================================================
phase_preflight() {
  step "Preflight  deps + sui CLI devnet env + operator key"
  require sui "Install it: https://docs.sui.io/guides/developer/getting-started/sui-install"
  require bun "Install it: https://bun.sh"
  require curl "Install curl."
  [ -f "$BACKEND/.env" ] || die "backend/.env not found. Copy backend/.env.example first."

  local live; live="$(chain_id)"
  [ -n "$live" ] || die "devnet unreachable at $RPC. Check your network."
  ok "devnet reachable, chain $live"

  local addr; addr="$(operator_addr)"
  [ -n "$addr" ] || die "could not derive the operator from backend/.env TESTING_WALLET_PK (is bun set up in backend/?)"
  ok "operator $addr"

  # The sui CLI signs the publish, so it must be on the devnet env AND active as the operator.
  if ! sui client envs --json 2>/dev/null | grep -q "\"$CLI_ENV\""; then
    sui client new-env --alias "$CLI_ENV" --rpc "$RPC" >/dev/null 2>&1 || true
  fi
  sui client switch --env "$CLI_ENV" >/dev/null 2>&1 || true
  local pk; pk="$(operator_pk)"
  [ -n "$pk" ] || die "TESTING_WALLET_PK is empty in backend/.env"
  sui keytool import "$pk" ed25519 >/dev/null 2>&1 || true   # no-op if already imported
  sui client switch --address "$addr" >/dev/null 2>&1 || true

  local active aenv; active="$(sui client active-address 2>/dev/null || true)"; aenv="$(sui client active-env 2>/dev/null || true)"
  [ "$aenv" = "$CLI_ENV" ] && ok "sui CLI env = $CLI_ENV ($RPC)" || fail "sui CLI env is '$aenv', expected $CLI_ENV"
  [ "$active" = "$addr" ] && ok "sui CLI active address = operator" || fail "sui CLI active address ($active) != operator ($addr)"
}

# ===========================================================================
# Phase: fund (faucet-loop the operator to the target balance)
# ===========================================================================
phase_fund() {
  step "Fund  faucet the operator to ~${FUND_SUI} SUI on devnet"
  local addr; addr="$(operator_addr)"; [ -n "$addr" ] || { fail "no operator address"; return 1; }
  local target=$(( FUND_SUI * 1000000000 ))
  local bal; bal="$(sui_mist "$addr")"; bal="${bal:-0}"
  info "operator $addr currently holds $(( bal / 1000000000 )) SUI"

  local tries=0 max=40
  while [ "${bal:-0}" -lt "$target" ] && [ "$tries" -lt "$max" ]; do
    tries=$((tries + 1))
    local resp code
    resp="$(curl -s -w '\n%{http_code}' --max-time 30 --location --request POST "$FAUCET" \
      --header 'Content-Type: application/json' \
      --data-raw "{\"FixedAmountRequest\":{\"recipient\":\"$addr\"}}" 2>/dev/null)"
    code="$(printf '%s' "$resp" | tail -n1)"
    case "$code" in
      200|201) info "faucet hit $tries ok (+~10 SUI)"; sleep 3 ;;
      429)     warn "faucet rate-limited (429), backing off 30s"; sleep 30 ;;
      *)       warn "faucet HTTP $code, retrying"; sleep 5 ;;
    esac
    bal="$(sui_mist "$addr")"; bal="${bal:-0}"
  done

  if [ "${bal:-0}" -ge "$target" ]; then
    ok "operator funded ($(( bal / 1000000000 )) SUI)"
  else
    warn "operator at $(( bal / 1000000000 )) SUI (< ${FUND_SUI}). Deploy needs only ~5 SUI so it may still work;"
    warn "re-run 'fund', or use scripts/faucet-spam.sh $addr to top up more aggressively."
  fi
}

# ===========================================================================
# Phase: deploy (publish the whole Predict stack to devnet)
# ===========================================================================
phase_deploy() {
  step "Deploy  publish DUSDC + predict (+deepbook +token), seed vault, oracle, round-trip"
  local addr; addr="$(operator_addr)"; [ -n "$addr" ] || { fail "no operator address"; return 1; }
  local bal; bal="$(sui_mist "$addr")"; bal="${bal:-0}"
  if [ "${bal:-0}" -lt 1200000000 ]; then
    fail "operator has only $(( bal / 1000000000 )) SUI; the publish needs at least ~1.5. Run 'fund' first."
    return 1
  fi
  # The bootstrap is network-aware: SUI_NETWORK=devnet makes it use `sui client publish` with
  # bundled deps and write deployed.devnet.json. We pass SUI_FULLNODE_URL so it ignores the stale
  # localnet URL still sitting in backend/.env (the explicit env var wins over .env).
  confirm "Publish the Predict stack to devnet now (force fresh)?" || { info "skipped"; return 1; }
  ( cd "$BACKEND" && SUI_NETWORK=devnet SUI_FULLNODE_URL="$RPC" bun run bootstrap --force ) || { fail "bootstrap failed (see output above)"; return 1; }

  # The publish dirties the vendored Move.lock files (committed; they pin on-chain deps) and may add
  # a stray token/Published.toml. Restore them so the repo stays clean. Ids live in deployed.devnet.json.
  if command -v git >/dev/null 2>&1; then
    git -C "$CONTRACTS" checkout -- predict/Move.lock deepbook/Move.lock token/Move.lock dusdc/Move.lock 2>/dev/null || true
    git -C "$CONTRACTS" clean -fq token/Published.toml 2>/dev/null || true
  fi

  [ -f "$DEPLOYED" ] && ok "deployed: package $(dfield packageId)" || { fail "deployed.devnet.json was not written"; return 1; }
}

# ===========================================================================
# Phase: wire (point BOTH apps at devnet)
# ===========================================================================
phase_wire() {
  step "Wire  point backend/.env + web/.env at devnet"
  [ -f "$DEPLOYED" ] || { fail "no deployed.devnet.json yet. Run 'deploy' first."; return 1; }

  # The bootstrap already wrote SUI_NETWORK + the PREDICT_*/VITE_PREDICT_* ids. We add the runtime
  # RPC (bootstrap only pins it for localnet), keep this machine a follower, and apply the frugal
  # funding knobs so a flip-to-operator here would behave on devnet too.
  set_env "$BACKEND/.env" \
    "SUI_NETWORK=devnet" \
    "SUI_FULLNODE_URL=$RPC" \
    "PIPS_OPERATOR_ENABLED=false" \
    "${FUND_KNOBS[@]}"
  ok "backend/.env -> devnet (follower)"

  set_env "$WEB/.env" \
    "VITE_SUI_NETWORK=devnet" \
    "VITE_SUI_FULLNODE_URL=$RPC"
  ok "web/.env -> devnet"
  info "frontend reads VITE_* at build time, so rebuild/restart the dev server to pick these up."
}

# ===========================================================================
# Phase: reset (fresh backend state on the shared DB)
# ===========================================================================
phase_reset() {
  step "Reset  re-arm users + wipe play history (fresh slate)"
  [ -f "$BACKEND/scripts/reprovision-users.ts" ] || { fail "backend/scripts/reprovision-users.ts missing"; return 1; }

  echo "A fresh devnet deploy makes every user's old on-chain manager + chips stale. Re-arming clears"
  echo "the onboarding flags so each user re-provisions (new manager + chips + gas) on their next login."
  warn "DATABASE_URL is a shared remote Postgres. This also affects the deployed box."
  confirm "Run reprovision-users.ts now?" || { info "skipped reprovision"; return 1; }
  ( cd "$BACKEND" && bun scripts/reprovision-users.ts ) || { fail "reprovision failed (DB reachable? DATABASE_URL set?)"; return 1; }

  echo
  if confirm "Wipe play history + PnL + stats too (clean slate)? ${red}deletes data, accounts kept${rst}"; then
    ( cd "$BACKEND" && bun scripts/wipe-history.ts --confirm ) || fail "wipe-history failed"
  else
    info "kept history"
  fi
}

# ===========================================================================
# Phase: dokploy (print the operator env to paste into the deployed box)
# ===========================================================================
phase_dokploy() {
  step "Deployed box  env to paste into Dokploy (makes it the devnet operator)"
  [ -f "$DEPLOYED" ] || { fail "no deployed.devnet.json yet. Run 'deploy' first."; return 1; }
  command -v base64 >/dev/null 2>&1 || { fail "base64 not available"; return 1; }

  local pkg pre dtype; pkg="$(dfield packageId)"; pre="$(dfield predictId)"
  dtype="$(grep -oE '"type"[ ]*:[ ]*"[^"]*"' "$DEPLOYED" | head -1 | sed -E 's/.*: *"([^"]*)"/\1/')"

  echo "The deployed backend reads the whole deployment from ${b}PIPS_DEPLOYED_JSON${rst} (deployed.devnet.json"
  echo "is gitignored, so it can't read a file). Set these on the backend service, then redeploy it:"
  echo
  echo "  ${b}PIPS_DEPLOYED_JSON${rst} (base64, copy the next line verbatim):"
  echo
  base64 < "$DEPLOYED" | tr -d '\n'; echo
  echo
  echo "  ${b}Backend (operator)${rst}:"
  echo "    SUI_NETWORK=devnet"
  echo "    SUI_FULLNODE_URL=$RPC"
  echo "    PIPS_OPERATOR_ENABLED=true            # the deployed box drives the markets"
  local k; for k in "${FUND_KNOBS[@]}"; do echo "    $k"; done
  echo
  info "the backend auto-runs a devnet faucet worker (every 5 min) that keeps the operator/settlement/"
  info "treasury/sponsor wallets + your personal address topped up. Tune with PIPS_DEVNET_FAUCET_* or"
  info "turn it off with PIPS_DEVNET_FAUCET_ENABLED=false. No env needed for the defaults."
  echo
  echo "  ${b}Frontend (rebuild)${rst}:"
  echo "    VITE_SUI_NETWORK=devnet"
  echo "    VITE_SUI_FULLNODE_URL=$RPC"
  echo "    VITE_PREDICT_PACKAGE_ID=$pkg"
  echo "    VITE_PREDICT_OBJECT_ID=$pre"
  echo "    VITE_DUSDC_TYPE=$dtype"
  echo
  warn "VITE_* are compile-time: ${b}rebuild${rst} the frontend, a restart alone won't pick them up."
  info "the raw JSON is at $DEPLOYED if you'd rather paste it un-encoded."
}

# ===========================================================================
# Phase: verify (end to end)
# ===========================================================================
phase_verify() {
  step "Verify  chain + package + operator"
  local live; live="$(chain_id)"
  [ -n "$live" ] && ok "devnet reachable, chain $live" || { fail "devnet unreachable"; return 1; }

  local addr bal; addr="$(operator_addr)"; bal="$(sui_mist "$addr")"; bal="${bal:-0}"
  [ "${bal:-0}" -ge 1200000000 ] && ok "operator funded ($(( bal / 1000000000 )) SUI)" || warn "operator low ($(( bal / 1000000000 )) SUI), run 'fund'"

  if [ -f "$DEPLOYED" ]; then
    local net pkg; net="$(dfield network)"; pkg="$(dfield packageId)"
    [ "$net" = "devnet" ] && ok "deployed.devnet.json present (network=$net)" || fail "deployed file network=$net (expected devnet)"
    local obj; obj="$(jrpc sui_getObject "[\"$pkg\",{\"showType\":true}]")"
    if echo "$obj" | grep -q '"error"\|"notExists"' || [ -z "$obj" ]; then
      fail "Predict package $pkg NOT live on devnet (devnet wiped? re-run 'deploy')"
    else
      ok "Predict package live on devnet ($pkg)"
    fi
  else
    warn "no deployed.devnet.json yet. Run 'deploy'."
  fi
  echo
  info "next: paste the 'dokploy' block on the deployed backend + rebuild the frontend, then log in and play."
}

# ===========================================================================
# orchestration
# ===========================================================================
guided_all() {
  echo "${b}Guided devnet refresh.${rst}  RPC $RPC  |  operator = $(operator_addr)"
  echo "This machine deploys + stays a follower; the deployed box becomes the operator (dokploy phase)."
  phase_preflight
  phase_fund
  phase_deploy || { warn "deploy did not complete; fix the error above and re-run: $0 deploy"; return 1; }
  phase_wire
  phase_reset
  phase_dokploy
  phase_verify
  echo; echo "${grn}${b}Devnet refresh complete.${rst}  Final checklist:"
  cat <<EOF
  [x] Predict stack published to devnet, package $(dfield packageId)
  [x] backend/.env + web/.env wired to devnet (this machine = follower)
  [x] users re-armed for re-provision
  [ ] paste PIPS_DEPLOYED_JSON + the operator env on the deployed box, redeploy it   (dokploy phase)
  [ ] rebuild the frontend with the new VITE_* values
  Then locally: cd backend && bun dev   and   cd web && bun dev
EOF
}

menu() {
  echo "${b}PIPS devnet refresh${rst}"
  echo "  rpc=$RPC  fund-target=${FUND_SUI} SUI  operator=$(operator_addr)"
  echo
  echo "  ${b}1${rst}) Guided full refresh (preflight -> verify)"
  echo "  ${b}2${rst}) preflight   deps + sui CLI devnet env + operator key"
  echo "  ${b}3${rst}) fund        faucet the operator"
  echo "  ${b}4${rst}) deploy      publish the Predict stack"
  echo "  ${b}5${rst}) wire        point both .envs at devnet"
  echo "  ${b}6${rst}) reset       re-arm users + wipe history"
  echo "  ${b}7${rst}) dokploy     print the operator env block"
  echo "  ${b}8${rst}) verify      chain + package + funding"
  echo "  ${b}q${rst}) quit"
  case "$(ask "select: ")" in
    1) guided_all ;;     2) phase_preflight ;;  3) phase_fund ;;
    4) phase_deploy ;;   5) phase_wire ;;       6) phase_reset ;;
    7) phase_dokploy ;;  8) phase_verify ;;
    q|Q|"") return 0 ;;  *) warn "unknown choice" ;;
  esac
}

case "${1:-menu}" in
  all|guided)        guided_all ;;
  preflight|phase0)  phase_preflight ;;
  fund)              phase_preflight && phase_fund ;;
  deploy)            phase_preflight && phase_deploy ;;
  wire)              phase_wire ;;
  reset)             phase_reset ;;
  dokploy)           phase_dokploy ;;
  verify)            phase_verify ;;
  menu)              menu ;;
  -h|--help|help)    sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown command '$1'. Try: $0 help" ;;
esac
