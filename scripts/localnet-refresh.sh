#!/usr/bin/env bash
# PIPS localnet refresh wizard.
#
# Fully resets and rebuilds the PIPS Sui localnet WITHOUT changing the chain id (we keep genesis.blob),
# redeploys our Predict stack, and re-arms every user, so the only thing to rewire downstream is one
# backend env var (PIPS_DEPLOYED_JSON) and the frontend's VITE_PREDICT_* values. Companion to the
# longer prose runbook in ../localnet-refresh.md.
#
# Use this when the node's on-disk state is corrupted (a restart while it was memory-bloated leaves the
# three RocksDB stores inconsistent and it comes back replaying old checkpoints with Predict missing),
# or as a clean nuke-and-repave of the chain.
#
# WHERE TO RUN IT: on the server box that hosts the node (it touches systemd + the data dir at
# /opt/pips-sui). Phases that don't need the box (deploy / reprovision / verify) run from anywhere with
# the repo + DB access. The wizard auto-detects what it can do here and skips what it can't.
#
# THE PHASES (each is also a standalone subcommand):
#   guardrails   Phase 0  memory cap + long stop timeout, remove any restart timer        [server, root]
#   reset        Phase 1  stop node, move the 3 DBs aside (reversible), restart from genesis [server, root]
#   deploy       Phase 2  republish Predict + DUSDC, reseed the vault, stand up the oracle  [repo + gRPC]
#   backend-env  Phase 3  print the PIPS_DEPLOYED_JSON to paste into Dokploy               [manual paste]
#   frontend     Phase 4  print the VITE_PREDICT_* values to rebuild the frontend with     [manual paste]
#   reprovision  Phase 5  re-arm every user so onboarding re-issues manager + chips + gas   [DB access]
#   verify       Phase 6  end-to-end health: chain id, Predict live, operator funded
#   rollback              restore the .OLD DBs if Phase 1 did not boot clean               [server, root]
#   wipe-history          optional: clear play history + stats for a clean slate           [DB access]
#
#   (no subcommand)       interactive menu / guided full run
#
# Overridable via env: PIPS_SUI_UNIT, PIPS_SUI_DATA, PIPS_EXPECT_CHAIN, PIPS_LOCAL_RPC, PIPS_PROXY_RPC,
# PIPS_GENESIS_OPERATOR. Defaults match the live deployment.

set -uo pipefail   # deliberately NOT -e: a wizard handles failures itself and offers rollback.

# ---- config (defaults match the live box; override via env) ----------------
UNIT="${PIPS_SUI_UNIT:-pips-sui}"
DATA_DIR="${PIPS_SUI_DATA:-/opt/pips-sui}"
EXPECT_CHAIN="${PIPS_EXPECT_CHAIN:-325c13db}"
LOCAL_RPC="${PIPS_LOCAL_RPC:-http://127.0.0.1:9000}"
PROXY_RPC="${PIPS_PROXY_RPC:-https://rpc.playpips.fun}"
GENESIS_OPERATOR="${PIPS_GENESIS_OPERATOR:-0xec9b41a3d2cdebad90c1e02c962a8a6a5fe1679972fc79c08ef10f7095df537e}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
DEPLOYED="$BACKEND/src/lib/sui/deployed.localnet.json"
LOCALNET="$ROOT/scripts/localnet.sh"

# ---- pretty ----------------------------------------------------------------
b=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; grn=$'\033[32m'; yel=$'\033[33m'; cyn=$'\033[36m'; rst=$'\033[0m'
ok()    { echo "  ${grn}ok${rst}   $*"; }
warn()  { echo "  ${yel}warn${rst} $*"; }
fail()  { echo "  ${red}fail${rst} $*"; }
info()  { echo "  ${dim}$*${rst}"; }
step()  { echo; echo "${b}${cyn}== $* ==${rst}"; }
die()   { echo "${red}error:${rst} $*" >&2; exit 1; }

# sudo only when not already root, so this works both as root on the box and via a sudo-capable user.
SUDO=""; [ "$(id -u)" = "0" ] || SUDO="sudo"

ask()     { local p="$1" a=""; read -r -p "$p" a </dev/tty || true; echo "$a"; }
confirm() { case "$(ask "$1 [y/N] ")" in y|Y|yes|YES) return 0;; *) return 1;; esac; }
confirm_word() { [ "$(ask "$2 (type ${b}$1${rst} to confirm): ")" = "$1" ]; }
pause()   { ask "$1 (press Enter to continue) " >/dev/null; }

# ---- rpc helpers -----------------------------------------------------------
jrpc() { curl -s --max-time 15 -X POST "$1" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":${3:-[]}}" 2>/dev/null || true; }
chain_id()    { jrpc "$1" sui_getChainIdentifier | grep -oE '"result":"[^"]*"' | sed -E 's/.*:"([^"]*)"/\1/'; }
checkpoint()  { jrpc "$1" sui_getLatestCheckpointSequenceNumber | grep -oE '"result":"[0-9]+"' | sed -E 's/.*:"([0-9]+)"/\1/'; }
sui_mist()    { jrpc "$1" suix_getBalance "[\"$2\"]" | grep -oE '"totalBalance":"[0-9]+"' | head -1 | sed -E 's/.*:"([0-9]+)"/\1/'; }
# value of a top-level "key":"string" in deployed.localnet.json (matches the first occurrence)
dfield()      { [ -f "$DEPLOYED" ] && grep -oE "\"$1\"[ ]*:[ ]*\"[^\"]*\"" "$DEPLOYED" | head -1 | sed -E 's/.*: *"([^"]*)"/\1/'; }

operator_addr() {
  ( cd "$BACKEND" && bun -e 'import {Ed25519Keypair} from "@mysten/sui/keypairs/ed25519"; import {decodeSuiPrivateKey} from "@mysten/sui/cryptography"; const pk=process.env.TESTING_WALLET_PK; if(!pk) process.exit(1); const {secretKey}=decodeSuiPrivateKey(pk); console.log(Ed25519Keypair.fromSecretKey(secretKey).getPublicKey().toSuiAddress())' 2>/dev/null )
}

# ---- environment detection -------------------------------------------------
has_unit()   { command -v systemctl >/dev/null 2>&1 && systemctl cat "$UNIT" >/dev/null 2>&1; }
node_local() { [ -n "$(chain_id "$LOCAL_RPC")" ]; }
# The RPC to actually query: the local node when it answers (on the box), else the proxied url. Avoids
# false "package live" when run off-server where 127.0.0.1 is unreachable.
reachable_rpc() { node_local && echo "$LOCAL_RPC" || echo "$PROXY_RPC"; }

# ===========================================================================
# Phase 0: guardrails (so the corruption never recurs)
# ===========================================================================
phase_guardrails() {
  step "Phase 0  guardrails (memory cap + clean-flush stop + no scheduled restarts)"
  has_unit || { warn "systemd unit '$UNIT' not found here. Run Phase 0 on the node's host box."; return 1; }

  echo "This caps the node's memory so it never bloats, gives systemd 300s to flush on stop, and"
  echo "REMOVES any scheduled restart timer (an interrupted flush during a bloated restart is exactly"
  echo "what corrupts the stores). ${yel}Note:${rst} this drops the old nightly restart in favor of the cap."
  confirm "Apply guardrails to '$UNIT'?" || { info "skipped"; return 1; }

  $SUDO mkdir -p "/etc/systemd/system/$UNIT.service.d"
  $SUDO tee "/etc/systemd/system/$UNIT.service.d/memory.conf" >/dev/null <<'EOF'
[Service]
MemoryHigh=15G
MemoryMax=18G
Restart=always
RestartSec=5
TimeoutStopSec=300
EOF
  $SUDO systemctl disable --now "$UNIT-restart.timer" 2>/dev/null || true
  $SUDO rm -f "/etc/systemd/system/$UNIT-restart.service" "/etc/systemd/system/$UNIT-restart.timer"
  $SUDO systemctl daemon-reload
  ok "guardrails applied"
  $SUDO systemctl show "$UNIT" -p MemoryHigh -p MemoryMax -p Restart -p TimeoutStopUSec | sed 's/^/  /'
}

# ===========================================================================
# Phase 1: reset the chain (reversible: DBs move to .OLD, not deleted)
# ===========================================================================
phase_reset() {
  step "Phase 1  reset the chain (reversible)"
  has_unit || { warn "systemd unit '$UNIT' not found here. Run Phase 1 on the node's host box."; return 1; }
  [ -d "$DATA_DIR" ] || { fail "data dir $DATA_DIR not found"; return 1; }

  # Disk headroom: a full disk at shutdown is what corrupts the flush in the first place.
  echo "Disk on the data volume:"; df -h "$DATA_DIR" | sed 's/^/  /'
  for d in authorities_db consensus_db full_node_db; do
    [ -e "$DATA_DIR/$d.OLD" ] && { fail "$DATA_DIR/$d.OLD already exists from a previous run. Remove or restore it first (rollback)."; return 1; }
  done

  echo
  echo "${red}This wipes the live chain state${rst} (authorities_db, consensus_db, full_node_db) and reboots"
  echo "from genesis. genesis.blob + the keystores are kept, so the chain id stays ${b}$EXPECT_CHAIN${rst} and"
  echo "the operator is re-funded by genesis. The old DBs are MOVED to *.OLD (reversible via 'rollback')."
  confirm_word RESET "Reset the chain now?" || { info "skipped"; return 1; }

  echo; info "stopping $UNIT (waits for a clean flush, up to TimeoutStopSec)..."
  $SUDO systemctl stop "$UNIT" || { fail "could not stop $UNIT"; return 1; }

  for d in authorities_db consensus_db full_node_db; do
    if [ -e "$DATA_DIR/$d" ]; then $SUDO mv "$DATA_DIR/$d" "$DATA_DIR/$d.OLD" && info "moved $d -> $d.OLD"; fi
  done

  info "starting $UNIT from genesis..."
  $SUDO systemctl start "$UNIT" || { fail "could not start $UNIT"; return 1; }
  printf '  waiting for the node'; for _ in $(seq 1 30); do [ -n "$(chain_id "$LOCAL_RPC")" ] && break; printf '.'; sleep 1; done; echo

  # --- verify a clean fresh chain ---
  local active id cp mist
  active="$($SUDO systemctl is-active "$UNIT" 2>/dev/null)"
  [ "$active" = "active" ] && ok "$UNIT active" || fail "$UNIT not active ($active)"
  id="$(chain_id "$LOCAL_RPC")"
  if [ "$id" = "$EXPECT_CHAIN" ]; then ok "chain id unchanged ($id)"
  elif [ -z "$id" ]; then fail "node not answering at $LOCAL_RPC"
  else fail "chain id is $id, expected $EXPECT_CHAIN (genesis lost?). Consider rollback."; fi
  cp="$(checkpoint "$LOCAL_RPC")"; [ -n "$cp" ] && info "checkpoint $cp (should be low / fresh)"
  mist="$(sui_mist "$LOCAL_RPC" "$GENESIS_OPERATOR")"
  if [ -n "$mist" ] && [ "$mist" -gt 0 ]; then ok "genesis operator re-funded ($((mist/1000000000)) SUI)"
  else fail "genesis operator $GENESIS_OPERATOR not funded on the fresh chain"; fi

  if [ "$active" = "active" ] && [ "$id" = "$EXPECT_CHAIN" ] && [ -n "$mist" ] && [ "$mist" -gt 0 ]; then
    echo; ok "${b}fresh chain is healthy${rst}"
    if confirm "Reclaim disk now by deleting the *.OLD DBs? (no rollback after this)"; then
      $SUDO rm -rf "$DATA_DIR"/*.OLD && ok "removed *.OLD"
    else info "keeping *.OLD as a safety net; remove later with: $SUDO rm -rf $DATA_DIR/*.OLD"; fi
    return 0
  fi
  echo; fail "the fresh chain did not come up clean. Use 'rollback' to restore the old DBs."
  return 1
}

rollback() {
  step "Rollback  restore the pre-reset DBs"
  has_unit || { warn "systemd unit '$UNIT' not found here."; return 1; }
  for d in authorities_db consensus_db full_node_db; do
    [ -e "$DATA_DIR/$d.OLD" ] || { fail "no $d.OLD to restore (already cleaned up?)"; return 1; }
  done
  confirm "Restore *.OLD over the current DBs and restart $UNIT?" || { info "skipped"; return 1; }
  $SUDO systemctl stop "$UNIT" || true
  for d in authorities_db consensus_db full_node_db; do
    $SUDO rm -rf "$DATA_DIR/$d"; $SUDO mv "$DATA_DIR/$d.OLD" "$DATA_DIR/$d"
  done
  $SUDO systemctl start "$UNIT"; sleep 8
  ok "restored; chain id now $(chain_id "$LOCAL_RPC")"
}

# ===========================================================================
# Phase 2: redeploy Predict onto the clean chain
# ===========================================================================
phase_deploy() {
  step "Phase 2  redeploy Predict + DUSDC + vault + oracle"
  [ -f "$LOCALNET" ] || { fail "scripts/localnet.sh not found at $LOCALNET. Run Phase 2 from a machine with the repo."; return 1; }
  command -v bun >/dev/null 2>&1 || { fail "bun is required to derive the operator + run the bootstrap"; return 1; }

  # The CLI signs the publish as whatever backend/.env TESTING_WALLET_PK derives to (localnet.sh
  # imports + switches to it). That address MUST be the genesis-funded operator on THIS chain, or the
  # publish fails for no gas. This is the #1 trap when deploying from a laptop whose key isn't genesis.
  local addr mist
  addr="$(operator_addr)"
  if [ -z "$addr" ]; then fail "could not derive the operator from backend/.env TESTING_WALLET_PK"; return 1; fi
  info "deploy will sign as $addr (backend/.env TESTING_WALLET_PK)"
  mist="$(sui_mist "$LOCAL_RPC" "$addr")"; [ -z "$mist" ] && mist="$(sui_mist "$PROXY_RPC" "$addr")"
  if [ -z "$mist" ] || [ "$mist" -lt 1200000000 ]; then
    fail "that operator is NOT funded on this chain (${mist:-0} MIST)."
    echo "       The publish needs the GENESIS-funded key ($GENESIS_OPERATOR)."
    echo "       Fix: run Phase 2 on the server where backend/.env TESTING_WALLET_PK is the genesis key,"
    echo "       or set TESTING_WALLET_PK to the genesis key (it lives in $DATA_DIR/sui.keystore) for the deploy."
    return 1
  fi
  ok "operator funded ($((mist/1000000000)) SUI), good to publish"

  echo; info "doctor (deps, node, gRPC publish path, CLI key, funding):"
  "$LOCALNET" doctor || true

  echo
  confirm "Run 'localnet.sh redeploy' now (force republish all packages + reseed)?" || { info "skipped"; return 1; }
  "$LOCALNET" redeploy || { fail "redeploy failed"; return 1; }
  echo; "$LOCALNET" status || true
  ok "new package: $(dfield packageId)"
}

# ===========================================================================
# Phase 3: point the deployed backend at the new ids (one env var)
# ===========================================================================
phase_backend_env() {
  step "Phase 3  update the deployed backend (PIPS_DEPLOYED_JSON in Dokploy)"
  [ -f "$DEPLOYED" ] || { fail "no $DEPLOYED yet. Run Phase 2 first."; return 1; }
  command -v base64 >/dev/null 2>&1 || { fail "base64 not available"; return 1; }

  echo "The Dokploy backend reads the WHOLE deployment from PIPS_DEPLOYED_JSON (see config.ts)."
  echo "Set these on the backend service, then redeploy/restart it:"
  echo
  echo "  ${b}PIPS_DEPLOYED_JSON${rst} (base64, copy the next line verbatim):"
  echo
  base64 < "$DEPLOYED" | tr -d '\n'; echo   # printed bare (no styling) so a copy-paste stays clean
  echo
  echo "  Keep these as-is:"
  echo "    SUI_NETWORK=localnet"
  echo "    SUI_FULLNODE_URL=$PROXY_RPC"
  echo
  info "the raw JSON is at $DEPLOYED if you prefer pasting it un-encoded."
  pause "Set PIPS_DEPLOYED_JSON in Dokploy and redeploy the backend"
}

# ===========================================================================
# Phase 4: rebuild the frontend with the new ids
# ===========================================================================
phase_frontend() {
  step "Phase 4  rebuild the frontend (VITE_PREDICT_* are compile-time)"
  [ -f "$DEPLOYED" ] || { fail "no $DEPLOYED yet. Run Phase 2 first."; return 1; }
  local pkg pre dtype
  pkg="$(dfield packageId)"; pre="$(dfield predictId)"
  dtype="$(grep -oE '"type"[ ]*:[ ]*"[^"]*"' "$DEPLOYED" | head -1 | sed -E 's/.*: *"([^"]*)"/\1/')"

  echo "The frontend bakes these at build time (chain id is unchanged, so the RPC url stays):"
  echo
  echo "    ${b}VITE_PREDICT_PACKAGE_ID${rst}=$pkg"
  echo "    ${b}VITE_PREDICT_OBJECT_ID${rst}=$pre"
  echo "    ${b}VITE_DUSDC_TYPE${rst}=$dtype"
  echo
  echo "    Unchanged: VITE_SUI_FULLNODE_URL=$PROXY_RPC  (+ VITE_SUI_NETWORK=localnet)"
  echo
  warn "a restart alone won't pick these up. ${b}Rebuild and redeploy${rst} the frontend."
  pause "Update the VITE_* values and rebuild + redeploy the frontend"
}

# ===========================================================================
# Phase 5: re-arm users so onboarding re-provisions them
# ===========================================================================
phase_reprovision() {
  step "Phase 5  re-arm users (manager + chips + gas re-issued on next login)"
  local script="$BACKEND/scripts/reprovision-users.ts"
  [ -f "$script" ] || { fail "$script missing"; return 1; }
  command -v bun >/dev/null 2>&1 || { fail "bun is required"; return 1; }

  echo "After a chain reset every user's on-chain manager + chips + gas are gone. This clears the"
  echo "onboarding flags so the next login re-provisions each user lazily. No funds move, accounts kept."
  confirm "Run reprovision-users.ts against the configured DATABASE_URL?" || { info "skipped"; return 1; }
  ( cd "$BACKEND" && bun scripts/reprovision-users.ts ) || { fail "reprovision failed (DB reachable? DATABASE_URL set?)"; return 1; }

  echo
  if confirm "Also wipe play history + stats for a clean slate? ${red}(deletes data)${rst}"; then
    ( cd "$BACKEND" && bun scripts/wipe-history.ts --confirm ) || fail "wipe-history failed"
  fi
}

# ===========================================================================
# Phase 6: end-to-end verify
# ===========================================================================
phase_verify() {
  step "Phase 6  end-to-end verify"
  if [ -f "$LOCALNET" ]; then "$LOCALNET" status || true; echo; fi

  local lid pid
  lid="$(chain_id "$LOCAL_RPC")"; pid="$(chain_id "$PROXY_RPC")"
  [ "$lid" = "$EXPECT_CHAIN" ] && ok "local node chain $lid" || warn "local node chain '$lid' (expected $EXPECT_CHAIN, or not reachable here)"
  [ "$pid" = "$EXPECT_CHAIN" ] && ok "proxied $PROXY_RPC chain $pid" || warn "proxied RPC chain '$pid' (cert / proxy down?)"

  if [ -f "$DEPLOYED" ]; then
    local pkg obj rpc; pkg="$(dfield packageId)"; rpc="$(reachable_rpc)"
    obj="$(jrpc "$rpc" sui_getObject "[\"$pkg\",{\"showType\":true}]")"
    if [ -z "$obj" ]; then warn "could not query $rpc to check the package"
    elif echo "$obj" | grep -q '"notExists"'; then fail "Predict package $pkg NOT on chain (redeploy / update PIPS_DEPLOYED_JSON)"
    else ok "Predict package live on $rpc ($pkg)"; fi
  fi
  echo
  info "now open the app, log in as a test user (triggers re-provision), confirm the DUSDC balance and a play."
}

wipe_history() {
  step "Wipe history  clear play history + stats (accounts kept)"
  command -v bun >/dev/null 2>&1 || { fail "bun is required"; return 1; }
  confirm_word WIPE "${red}Delete all plays, stats, achievements, scores?${rst}" || { info "skipped"; return 1; }
  ( cd "$BACKEND" && bun scripts/wipe-history.ts --confirm )
}

# ===========================================================================
# orchestration
# ===========================================================================
guided_all() {
  echo "${b}Guided full refresh.${rst} Each phase confirms before it acts; skip any with 'n'."
  echo "Detected here:"
  has_unit    && ok "systemd unit '$UNIT' (can do Phase 0/1/rollback)" || warn "no '$UNIT' unit (Phase 0/1 will skip; run them on the box)"
  node_local  && ok "node reachable at $LOCAL_RPC"                     || warn "no local node at $LOCAL_RPC"
  [ -f "$LOCALNET" ] && ok "repo present (can deploy)"                 || warn "scripts/localnet.sh missing (Phase 2 needs the repo)"
  echo
  phase_guardrails
  phase_reset || { warn "Phase 1 did not complete; stopping the guided run. Fix or 'rollback', then resume."; return 1; }
  phase_deploy || { warn "Phase 2 did not complete; stopping. Resume with: $0 deploy"; return 1; }
  phase_backend_env
  phase_frontend
  phase_reprovision
  phase_verify
  echo; echo "${grn}${b}Refresh complete.${rst} Final checklist:"
  cat <<EOF
  [x] chain reset, id still $EXPECT_CHAIN
  [x] Predict redeployed, package $(dfield packageId)
  [ ] PIPS_DEPLOYED_JSON updated in Dokploy + backend restarted   (Phase 3)
  [ ] frontend VITE_* updated + REBUILT                           (Phase 4)
  [x] users re-armed for re-provision
  Tick the two manual boxes once done.
EOF
}

menu() {
  echo "${b}PIPS localnet refresh wizard${rst}"
  echo "  unit=$UNIT  data=$DATA_DIR  chain=$EXPECT_CHAIN  node=$LOCAL_RPC"
  echo
  echo "  ${b}1${rst}) Guided full refresh (phases 0 -> 6)"
  echo "  ${b}2${rst}) Phase 0  guardrails"
  echo "  ${b}3${rst}) Phase 1  reset the chain"
  echo "  ${b}4${rst}) Phase 2  redeploy Predict"
  echo "  ${b}5${rst}) Phase 3  backend env (Dokploy)"
  echo "  ${b}6${rst}) Phase 4  frontend rebuild"
  echo "  ${b}7${rst}) Phase 5  re-arm users"
  echo "  ${b}8${rst}) Phase 6  verify"
  echo "  ${b}r${rst}) rollback the chain reset"
  echo "  ${b}w${rst}) wipe play history (clean slate)"
  echo "  ${b}q${rst}) quit"
  case "$(ask "select: ")" in
    1) guided_all ;;            2) phase_guardrails ;;   3) phase_reset ;;
    4) phase_deploy ;;          5) phase_backend_env ;;  6) phase_frontend ;;
    7) phase_reprovision ;;     8) phase_verify ;;
    r|R) rollback ;;            w|W) wipe_history ;;
    q|Q|"") return 0 ;;         *) warn "unknown choice" ;;
  esac
}

case "${1:-menu}" in
  all|guided)   guided_all ;;
  guardrails|phase0)   phase_guardrails ;;
  reset|phase1)        phase_reset ;;
  deploy|phase2)       phase_deploy ;;
  backend-env|phase3)  phase_backend_env ;;
  frontend|phase4)     phase_frontend ;;
  reprovision|phase5)  phase_reprovision ;;
  verify|phase6)       phase_verify ;;
  rollback)            rollback ;;
  wipe-history)        wipe_history ;;
  menu)                menu ;;
  -h|--help|help)
    sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown command '$1'. Try: $0 help" ;;
esac
