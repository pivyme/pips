#!/usr/bin/env bash
# Hammer the Sui devnet faucet N times for one address.
# Devnet rate-limits per IP, so expect 429s. We back off and keep going.
#
# Usage:
#   scripts/faucet-spam.sh <address> [count] [delay_seconds]
#
# Defaults: count=1000, delay=2s between requests.

set -uo pipefail

ADDR="${1:-0x4eddfba6fcb9a6c5e14476299a03173fdcaf0bbc06cac505db262ee27eea4a0c}"
COUNT="${2:-1000}"
DELAY="${3:-2}"
ENDPOINT="${FAUCET_URL:-https://faucet.devnet.sui.io/v2/gas}"

ok=0
fail=0

echo "faucet: $ENDPOINT"
echo "addr:   $ADDR"
echo "runs:   $COUNT  (delay ${DELAY}s)"
echo

for i in $(seq 1 "$COUNT"); do
  body=$(curl -s -w "\n%{http_code}" --location --request POST "$ENDPOINT" \
    --header 'Content-Type: application/json' \
    --data-raw "{\"FixedAmountRequest\":{\"recipient\":\"$ADDR\"}}")

  code=$(printf '%s' "$body" | tail -n1)
  json=$(printf '%s' "$body" | sed '$d')

  if [ "$code" = "200" ] || [ "$code" = "201" ]; then
    ok=$((ok+1))
    echo "[$i/$COUNT] OK   ($ok ok / $fail fail)"
  elif [ "$code" = "429" ]; then
    fail=$((fail+1))
    echo "[$i/$COUNT] 429 rate-limited, backing off 30s   ($ok ok / $fail fail)"
    sleep 30
    continue
  else
    fail=$((fail+1))
    echo "[$i/$COUNT] HTTP $code  $json   ($ok ok / $fail fail)"
  fi

  sleep "$DELAY"
done

echo
echo "done: $ok ok, $fail fail"
