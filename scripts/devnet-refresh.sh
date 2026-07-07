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
#   scripts/devnet-refresh.sh recover    # FAST, non-interactive, shortest-downtime auto-recover (do this on a wipe)
#   scripts/devnet-refresh.sh watch      # poll devnet, auto-run recover the moment it wipes (leave running)
#   scripts/devnet-refresh.sh all        # guided full run (preflight -> verify), confirms each step
#
# SHORT-DOWNTIME RECOVERY (the whole point): `recover` funds only enough to publish (one faucet hit),
# republishes, then writes the fresh deploy record to the SHARED DB. The deployed box's deploy-watch
# worker sees the new package id and RESTARTS onto it on its own (no Dokploy env paste, no redeploy),
# and the frontend re-reads the live DUSDC type from /config (no Vercel rebuild). Requires `bun run
# db:push` once (adds the AppConfig table) and a restart-on-exit box container (Dokploy default).
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
FUND_SUI="${PIPS_DEVNET_FUND_SUI:-60}"        # operator target: deploy (~2 SUI) + a working buffer. The
                                              # devnet-faucet worker sustains it after, so this stays small.
# Minimum operator balance to START a publish. The deploy reorder for short downtime: fund only this much
# (usually ONE 10-SUI faucet hit), publish immediately, and let the box's faucet worker stack it after.
# This is the whole speed win over phase_fund, which blocks all the way to FUND_SUI before deploying.
DEPLOY_MIN_SUI="${PIPS_DEVNET_DEPLOY_MIN_SUI:-10}"
# Hard ceiling on the publish. A healthy 4-package publish + seed + round-trip is ~2-4 min; anything
# past this is the local sui CLI hanging against a freshly-wiped devnet whose protocol it lags (the
# publish connects then stalls on a now-missing RPC method). Fail fast with the fix instead of hanging.
DEPLOY_TIMEOUT="${PIPS_DEVNET_DEPLOY_TIMEOUT:-420}"
CLI_ENV="devnet"
# Non-interactive switch. `recover`/`watch` set this so confirm/pause auto-proceed (unattended runs).
AUTO="${AUTO:-0}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
WEB="$ROOT/web"
CONTRACTS="$ROOT/contracts"
DEPLOYED="$BACKEND/src/lib/sui/deployed.devnet.json"

# Devnet funding profile, tuned so you NEVER hand-fund a fukton of SUI: the public faucet (free,
# 10 SUI/hit) is the primary source and the operator's own balance barely moves.
#
# The trick is the floor ordering. The devnet-faucet worker keeps the operator + all three ops wallets
# at/above PIPS_DEVNET_FAUCET_MIN_SUI. That floor sits ABOVE the operator->ops-wallet topup MINs below,
# so the faucet always refills a wallet before it dips low enough for the operator to step in. So the
# operator->ops deposits become a rare backstop, and the operator only ever spends SUI on its own gas
# (price-push / oracle-roll / settle), which the faucet replenishes the same way. Start it with a few
# faucet hits and it sustains itself; no manual top-ups, no operator hoarding hundreds of SUI.
FUND_KNOBS=(
  # PRIMARY: faucet floor for the operator + sponsor + settlement + treasury (+ the personal extra).
  "PIPS_DEVNET_FAUCET_MIN_SUI=20"
  # BACKSTOP: operator -> ops wallets. MINs are below the faucet floor (so the faucet wins), and the
  # deposits are small, so a backstop hit only nudges, it never drains the operator.
  "PIPS_SPONSOR_MIN_SUI=10"
  "PIPS_SPONSOR_TOPUP_SUI=25"
  "PIPS_SETTLEMENT_MIN_SUI=10"
  "PIPS_SETTLEMENT_TOPUP_SUI=25"
  "PIPS_TREASURY_MIN_SUI=6"
  "PIPS_TREASURY_TOPUP_SUI=20"
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
confirm() { [ "$AUTO" = "1" ] && return 0; case "$(ask "$1 [y/N] ")" in y|Y|yes|YES) return 0;; *) return 1;; esac; }
confirm_word() { [ "$AUTO" = "1" ] && return 0; [ "$(ask "$2 (type ${b}$1${rst} to confirm): ")" = "$1" ]; }
pause()   { [ "$AUTO" = "1" ] && return 0; ask "$1 (press Enter to continue) " >/dev/null; }

require() { command -v "$1" >/dev/null 2>&1 || die "the '$1' CLI is not installed. $2"; }

# Run a command under a timeout if the system has one (coreutils `timeout`, or `gtimeout` on macOS via
# `brew install coreutils`); otherwise run it plain. -k 10 hard-kills 10s after the soft TERM so a wedged
# publish can't linger. Returns 124 on timeout (the standard coreutils code).
tmo() {
  local secs="$1"; shift
  if   command -v timeout  >/dev/null 2>&1; then timeout  -k 10 "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout -k 10 "$secs" "$@"
  else "$@"; fi
}

# ---- rpc / faucet helpers --------------------------------------------------
# Chain reads go through the gRPC helper (JSON-RPC is deprecated). Run it from backend/ so @mysten/sui
# resolves, and pass the active RPC via SUI_FULLNODE_URL. Each helper stays quiet on failure (empty
# stdout) so the callers' `${x:-0}`/empty-string checks behave exactly as they did over curl.
sgrpc() { ( cd "$BACKEND" && SUI_FULLNODE_URL="$RPC" bun "$ROOT/scripts/sui-grpc.ts" "$@" 2>/dev/null ); }
chain_id() { sgrpc chain-id; }
sui_mist() { sgrpc balance "$1"; }
# object_live <id>: succeeds (exit 0) only if the object still exists on chain; fails when it is
# missing (devnet wipe) or the read errored. Replaces the inline sui_getObject existence checks.
object_live() { local out; out="$(sgrpc object "$1")"; [ -n "$out" ] && [ "$out" != "notExists" ]; }
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
  if ! ( cd "$BACKEND" && SUI_NETWORK=devnet SUI_FULLNODE_URL="$RPC" tmo "$DEPLOY_TIMEOUT" bun run bootstrap --force ); then
    local rc=$?
    if [ "$rc" = "124" ]; then
      fail "publish TIMED OUT after ${DEPLOY_TIMEOUT}s. This is almost always the local sui CLI lagging the"
      fail "freshly-wiped devnet protocol (the publish connects, then stalls on a now-missing RPC method)."
      fail "fix: ${b}brew upgrade sui${rst} (or install the build matching devnet), then re-run: $0 recover"
    else
      fail "bootstrap failed (see output above)"
    fi
    return 1
  fi

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
  step "Wire  point backend/.env + web/.env + backend/.env.production at devnet"
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

  # Keep the production reference (backend/.env.production) in sync so the deployed box gets the devnet
  # ids too. It is the OPERATOR (OPERATOR_ENABLED=true), unlike the local follower above, and carries
  # the whole deploy record in PIPS_DEPLOYED_JSON (deployed.devnet.json is gitignored + not in the image,
  # so the box reads it from this env var, see config.ts loadDeployed). Without this the box would still
  # point at the dead localnet package after a refresh. The file is gitignored, so this never commits ids.
  local prod="$BACKEND/.env.production"
  if [ -f "$prod" ]; then
    local prod_pairs=(
      "SUI_NETWORK=devnet"
      "SUI_FULLNODE_URL=$RPC"
      "PIPS_OPERATOR_ENABLED=true"
      "PREDICT_PACKAGE_ID=$(dfield packageId)"
      "PREDICT_REGISTRY_ID=$(dfield registryId)"
      "PREDICT_OBJECT_ID=$(dfield predictId)"
      "PREDICT_ADMIN_CAP_ID=$(dfield adminCapId)"
      "${FUND_KNOBS[@]}"
    )
    # Minify deployed.devnet.json onto one line for the env value (config.ts accepts raw JSON or base64).
    local djson
    djson="$(DEPLOYED_FILE_PATH="$DEPLOYED" bun -e 'import fs from "fs"; process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(process.env.DEPLOYED_FILE_PATH, "utf8"))))' 2>/dev/null)"
    [ -n "$djson" ] && prod_pairs+=("PIPS_DEPLOYED_JSON=$djson") || warn "could not minify $DEPLOYED for PIPS_DEPLOYED_JSON (left as-is)"
    set_env "$prod" "${prod_pairs[@]}"
    ok "backend/.env.production -> devnet (operator). Paste it (or just PIPS_DEPLOYED_JSON) into Dokploy + redeploy."
  else
    info "no backend/.env.production to sync (skipping)"
  fi
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
    if object_live "$pkg"; then
      ok "Predict package live on devnet ($pkg)"
    else
      fail "Predict package $pkg NOT live on devnet (devnet wiped? re-run 'deploy')"
    fi
  else
    warn "no deployed.devnet.json yet. Run 'deploy'."
  fi
  echo
  info "next: paste the 'dokploy' block on the deployed backend + rebuild the frontend, then log in and play."
}

# ===========================================================================
# Phase: fund_fast (faucet only enough to publish, then return)
# ===========================================================================
phase_fund_fast() {
  step "Fund (fast)  faucet the operator to the deploy minimum (~${DEPLOY_MIN_SUI} SUI)"
  local addr; addr="$(operator_addr)"; [ -n "$addr" ] || { fail "no operator address"; return 1; }
  local target=$(( DEPLOY_MIN_SUI * 1000000000 ))
  local bal; bal="$(sui_mist "$addr")"; bal="${bal:-0}"
  info "operator holds $(( bal / 1000000000 )) SUI"
  local tries=0 max=12
  while [ "${bal:-0}" -lt "$target" ] && [ "$tries" -lt "$max" ]; do
    tries=$((tries + 1))
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 --location --request POST "$FAUCET" \
      --header 'Content-Type: application/json' --data-raw "{\"FixedAmountRequest\":{\"recipient\":\"$addr\"}}" 2>/dev/null)"
    case "$code" in
      200|201) info "faucet hit $tries ok"; sleep 2 ;;
      429)     warn "faucet rate-limited (429), backing off 20s"; sleep 20 ;;
      *)       warn "faucet HTTP $code, retrying"; sleep 4 ;;
    esac
    bal="$(sui_mist "$addr")"; bal="${bal:-0}"
  done
  # The publish needs ~1.5 SUI; once we clear that, stop waiting and deploy. The buffer fills after.
  if [ "${bal:-0}" -ge 1200000000 ]; then
    ok "operator has $(( bal / 1000000000 )) SUI, enough to publish"
  else
    fail "operator at $(( bal / 1000000000 )) SUI after $tries hits (faucet rate-limited; set PIPS_DEVNET_FAUCET or use scripts/faucet-spam.sh)"
    return 1
  fi
}

# ===========================================================================
# Phase: publish_db (write the fresh deploy record to the shared DB)
# ===========================================================================
phase_publish_db() {
  step "Publish  write the fresh deploy record to the shared DB (the box self-heal trigger)"
  [ -f "$DEPLOYED" ] || { fail "no deployed.devnet.json yet. Run 'deploy' first."; return 1; }
  if ( cd "$BACKEND" && bun scripts/publish-deploy-record.ts ); then
    ok "deploy record in DB; the deployed box adopts it on its next deploy-watch tick (~20s)"
  else
    fail "publish-deploy-record failed. If it mentions AppConfig, run 'bun run db:push' from backend/ once, then re-run."
    return 1
  fi
}

# ===========================================================================
# Phase: rearm (re-provision users only, no history wipe, non-interactive)
# ===========================================================================
phase_rearm() {
  step "Re-arm  clear onboarding flags so users re-provision (new manager + chips) on next login"
  [ -f "$BACKEND/scripts/reprovision-users.ts" ] || { fail "reprovision-users.ts missing"; return 1; }
  ( cd "$BACKEND" && bun scripts/reprovision-users.ts ) && ok "users re-armed" || { fail "reprovision failed (DB reachable?)"; return 1; }
}

# ===========================================================================
# recover  the one-shot, non-interactive, short-downtime path
# ===========================================================================
phase_recover() {
  AUTO=1
  echo "${b}${cyn}Devnet auto-recover.${rst}  RPC $RPC  |  operator $(operator_addr)"
  echo "Funds the minimum, publishes, writes the DB record. The box self-heals; no Dokploy paste, no Vercel rebuild."
  phase_preflight  || { fail "preflight failed"; return 1; }
  phase_fund_fast  || { fail "could not fund the operator"; return 1; }
  phase_deploy     || { fail "deploy failed; fix the error above and re-run: $0 recover"; return 1; }
  phase_publish_db || warn "deploy is live but the DB record was not written: the box will NOT self-heal until you run '$0 recover' again (or 'bun run db:push' first)."
  phase_wire
  phase_rearm
  phase_verify
  echo; echo "${grn}${b}Recovery complete.${rst}"
  cat <<EOF
  [x] Predict stack republished to devnet, package $(dfield packageId)
  [x] deploy record written to the shared DB  -> the box restarts onto it within ~20s (deploy-watch)
  [x] backend/.env + web/.env wired to devnet (this machine = follower)
  [x] users re-armed for re-provision
  The box's devnet-faucet worker refills the operator/settlement/treasury/sponsor wallets on the fresh
  chain automatically. The frontend re-reads the live DUSDC type from /config on next load. Zero-touch.
EOF
}

# ===========================================================================
# watch  poll devnet and auto-recover the moment the package is wiped
# ===========================================================================
phase_watch() {
  local interval="${PIPS_DEVNET_WATCH_INTERVAL:-60}"
  step "Watch  poll devnet every ${interval}s; auto-recover when the Predict package vanishes"
  info "leave this running on the deploy machine (needs the sui CLI + Move sources). Ctrl-C to stop."
  phase_preflight || { fail "preflight failed; fix it before watching"; return 1; }
  while true; do
    local pkg live
    pkg="$(dfield packageId)"; live="$(chain_id)"
    if [ -z "$live" ]; then
      warn "$(ask_now) devnet unreachable, retrying in ${interval}s"
    elif [ -z "$pkg" ]; then
      warn "$(ask_now) no local deploy record; running first recover"
      phase_recover
    elif object_live "$pkg"; then
      info "$(ask_now) ok  chain $live  pkg ${pkg:0:12}… live"
    else
      warn "$(ask_now) Predict package ${pkg:0:12}… is GONE (devnet wiped). Auto-recovering."
      phase_recover
    fi
    sleep "$interval"
  done
}
# tiny HH:MM:SS stamp for the watch log (date is allowed in shell, just not in workflow scripts)
ask_now() { date '+%H:%M:%S'; }

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
  [x] backend/.env.production synced to devnet (the operator box reference: ids + PIPS_DEPLOYED_JSON)
  [x] users re-armed for re-provision
  [ ] paste backend/.env.production (or just PIPS_DEPLOYED_JSON + operator env) on the box, redeploy it   (dokploy phase)
  [ ] rebuild the frontend with the new VITE_* values
  Then locally: cd backend && bun dev   and   cd web && bun dev
EOF
}

menu() {
  echo "${b}PIPS devnet refresh${rst}"
  echo "  rpc=$RPC  fund-target=${FUND_SUI} SUI  operator=$(operator_addr)"
  echo
  echo "  ${b}1${rst}) ${grn}recover${rst}     one-shot auto-recover (fund -> publish -> DB record -> wire). Shortest downtime."
  echo "  ${b}2${rst}) ${grn}watch${rst}       poll devnet and auto-recover the moment it wipes"
  echo "  ${b}3${rst}) refresh     guided full refresh (preflight -> verify, with prompts)"
  echo "  ${b}4${rst}) preflight   deps + sui CLI devnet env + operator key"
  echo "  ${b}5${rst}) fund        faucet the operator"
  echo "  ${b}6${rst}) deploy      publish the Predict stack"
  echo "  ${b}7${rst}) wire        point both .envs at devnet"
  echo "  ${b}8${rst}) reset       re-arm users + wipe history"
  echo "  ${b}9${rst}) dokploy     print the operator env block"
  echo "  ${b}0${rst}) verify      chain + package + funding"
  echo "  ${b}q${rst}) quit"
  case "$(ask "select: ")" in
    1) phase_recover ;;  2) phase_watch ;;      3) guided_all ;;
    4) phase_preflight ;; 5) phase_fund ;;      6) phase_deploy ;;
    7) phase_wire ;;     8) phase_reset ;;      9) phase_dokploy ;;
    0) phase_verify ;;
    q|Q|"") return 0 ;;  *) warn "unknown choice" ;;
  esac
}

case "${1:-menu}" in
  recover|auto-recover) phase_recover ;;
  watch)             phase_watch ;;
  all|guided)        guided_all ;;
  preflight|phase0)  phase_preflight ;;
  fund)              phase_preflight && phase_fund ;;
  fund-fast)         phase_preflight && phase_fund_fast ;;
  deploy)            phase_preflight && phase_deploy ;;
  publish-db)        phase_publish_db ;;
  wire)              phase_wire ;;
  reset)             phase_reset ;;
  rearm)             phase_rearm ;;
  dokploy)           phase_dokploy ;;
  verify)            phase_verify ;;
  menu)              menu ;;
  -h|--help|help)    sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown command '$1'. Try: $0 help" ;;
esac
