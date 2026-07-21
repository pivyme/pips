#!/usr/bin/env bash
# Publish the stateless pips_logger package and wire the matching runtime env.
# Usage: ./deploy.sh [testnet|mainnet]
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$PKG_DIR/../.." && pwd)"
GAS_BUDGET="${GAS_BUDGET:-200000000}"

say() { printf '\033[1;36m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }
die() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }
confirm() { read -r -p "$1 [y/N] " answer; [[ "$answer" =~ ^[Yy]$ ]]; }

upsert_env() {
  local file="$1" key="$2" value="$3"
  touch "$file"
  if grep -qE "^${key}=" "$file"; then
    sed -i.bak -E "s|^${key}=.*|${key}=${value}|" "$file"
    rm -f "$file.bak"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
  say "  set $key in $file"
}

command -v sui >/dev/null || die "sui CLI not found. Install it with suiup first."
command -v jq >/dev/null || die "jq not found. Install it before publishing."

NET="${1:-}"
if [[ -z "$NET" ]]; then
  read -r -p "Network to deploy to (testnet/mainnet) [testnet]: " NET
  NET="${NET:-testnet}"
fi
[[ "$NET" == "testnet" || "$NET" == "mainnet" ]] || die "network must be testnet or mainnet"

ACTIVE_ENV="$(sui client active-env 2>/dev/null || echo '?')"
ACTIVE_ADDR="$(sui client active-address 2>/dev/null || echo '?')"
say "Sui active env: $ACTIVE_ENV   active address: $ACTIVE_ADDR"
if [[ "$ACTIVE_ENV" != "$NET" ]]; then
  warn "Active Sui env ($ACTIVE_ENV) does not match target ($NET)."
  confirm "Switch the Sui client to '$NET'?" && sui client switch --env "$NET" || die "aborted: wrong network"
  ACTIVE_ADDR="$(sui client active-address)"
fi
say "Publisher (pays gas and receives UpgradeCap): $ACTIVE_ADDR"
sui client gas --json 2>/dev/null | jq -r '.[0] | "  gas coin: \(.gasCoinId)  balance: \(.mistBalance) MIST"' 2>/dev/null || warn "Could not read publisher gas."

if [[ "$NET" == "mainnet" ]]; then
  warn "MAINNET publishing uses real SUI and is permanent."
  confirm "Publisher and mainnet target are correct?" || die "aborted"
fi
confirm "Publish pips_logger to $NET now?" || die "aborted"

cd "$PKG_DIR"
say "Building..."
sui move build >/dev/null
say "Publishing..."
OUT="$(sui client publish --gas-budget "$GAS_BUDGET" --json)"
PKG="$(echo "$OUT" | jq -r '.objectChanges[] | select(.type == "published") | .packageId')"
CAP="$(echo "$OUT" | jq -r '.objectChanges[] | select((.objectType // "") | test("::package::UpgradeCap$")) | .objectId')"
DIGEST="$(echo "$OUT" | jq -r '.digest')"
[[ "$PKG" =~ ^0x[0-9a-f]+$ ]] || die "could not parse package id from publish output"

REC="$PKG_DIR/deployed.${NET}.json"
jq -n --arg network "$NET" --arg packageId "$PKG" --arg upgradeCapId "$CAP" --arg digest "$DIGEST" --arg publisher "$ACTIVE_ADDR" \
  '{network:$network, packageId:$packageId, upgradeCapId:$upgradeCapId, digest:$digest, publisher:$publisher}' > "$REC"
say "Published package: $PKG"
say "UpgradeCap: ${CAP:-<none>}"
say "Digest: $DIGEST"
say "Wrote $REC. Commit this public deploy record."

if [[ "$NET" == "testnet" ]]; then
  upsert_env "$ROOT/backend/.env" PIPS_LOGGER_PACKAGE_ID "$PKG"
else
  upsert_env "$ROOT/backend/.env.production" PIPS_LOGGER_PACKAGE_ID "$PKG"
fi

say "Explorer: https://suiscan.xyz/$NET/object/$PKG"
say "Next: restart the backend, then run: cd backend && bun run pips:post-deploy-check"
