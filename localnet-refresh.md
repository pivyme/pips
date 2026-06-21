# Localnet Refresh Runbook

How to fully reset and rebuild the PIPS Sui localnet on the server, get the app back up, and re-fund every user, **without** changing the chain id (so nothing needs rewiring beyond one env var on the backend and the `VITE_PREDICT_*` values on the frontend).

Use this when the node's on-disk state gets corrupted (e.g. a restart while it was memory-bloated left the three DBs out of sync and it came back replaying old checkpoints with the Predict deployment missing). It is also a clean "nuke and repave" for the chain.

---

## TL;DR: the wizard

`scripts/localnet-refresh.sh` drives this whole runbook, with confirmations, verification gates, and rollback. Run it **on the server box** (it touches systemd and the data dir); the deploy / reprovision / verify phases work from anywhere with the repo + DB access.

```bash
scripts/localnet-refresh.sh            # interactive menu
scripts/localnet-refresh.sh all        # guided full run (phases 0 -> 6)

# or a single phase:
scripts/localnet-refresh.sh guardrails   # Phase 0
scripts/localnet-refresh.sh reset        # Phase 1  (reversible)
scripts/localnet-refresh.sh deploy       # Phase 2
scripts/localnet-refresh.sh backend-env  # Phase 3  (prints the value to paste)
scripts/localnet-refresh.sh frontend     # Phase 4  (prints the VITE_* values)
scripts/localnet-refresh.sh reprovision  # Phase 5
scripts/localnet-refresh.sh verify        # Phase 6
scripts/localnet-refresh.sh rollback      # undo Phase 1 if it didn't boot clean
```

Phases 3 and 4 are inherently manual (Dokploy env + a frontend rebuild on whatever host serves it), so the wizard prints the exact values and waits while you paste them. Everything else it does for you. The sections below are the reference the wizard follows, with the why behind each step.

---

## Why this happens (so future-you remembers)

`sui start` flushes its in-memory state to disk on shutdown. If the box is **memory-starved** (the node bloated to ~21/23GB) or **disk-starved** at shutdown, the flush gets cut short by SIGKILL and the three stores (`authorities_db`, `consensus_db`, `full_node_db`) come back inconsistent. The node then re-executes from an early checkpoint instead of resuming at the tip. The data is on disk but not cleanly recoverable, so we reset.

**Prevention is baked into Phase 0 below**: cap memory so it never bloats, give systemd time to flush, never restart it while bloated.

---

## Key facts (current deployment)

| Thing | Value |
|---|---|
| systemd unit | `pips-sui.service` |
| ExecStart | `sui start --network.config /opt/pips-sui --with-faucet=127.0.0.1:9123` |
| Data dir | `/opt/pips-sui` |
| Wipe these (rebuilt from genesis) | `authorities_db/`, `consensus_db/`, `full_node_db/` |
| Keep these (the chain identity + keys) | `genesis.blob`, `*.yaml`, `sui.keystore`, `sui.aliases` |
| Chain id (unchanged, we keep genesis) | `325c13db` |
| Genesis-funded operator | `0xec9b41a3d2cdebad90c1e02c962a8a6a5fe1679972fc79c08ef10f7095df537e` (~150M SUI) |
| Local RPC | `http://127.0.0.1:9000` |
| Proxied RPC (apps/browser) | `https://rpc.playpips.fun` |
| Deploy/gRPC origin (CLI publishes here) | `http://95.111.237.44:9000` (`PIPS_DEPLOY_RPC`) |
| Deployed backend reads ids from | env var **`PIPS_DEPLOYED_JSON`** (full deployed.localnet.json, raw or base64) |
| Who actually signs the publish | the key in **`backend/.env` `TESTING_WALLET_PK`** on the deploying machine (must be the genesis key) |

---

## Preflight (run first, do not skip)

```bash
# 1. Free disk. RocksDB needs headroom; a full disk is what corrupts restarts.
df -h /opt/pips-sui /

# 2. Is the deploy tool on the server? (needed for Phase 2)
find / -path '*scripts/localnet.sh' 2>/dev/null

# 3. Confirm the node is the only thing on this unit and see its state
systemctl status pips-sui --no-pager | head -6
```

Decide before continuing:
- **Disk:** need at least a few GB free. The wizard's reset *moves* the old DBs aside first (reversible). If disk is tight, you must `rm -rf` them directly instead (lose the safety net) or you won't have room.
- **Repo + deploy key:** Phase 2 publishes with `scripts/localnet.sh`, which signs as whatever `backend/.env` `TESTING_WALLET_PK` resolves to (see the trap in Phase 2). If the repo + the genesis key are on the **server**, deploy there. Otherwise deploy from a machine where you've set `TESTING_WALLET_PK` to the genesis key.

---

## Phase 0: Guardrails (so it never happens again)

```bash
# Memory cap + long stop timeout (always flush clean) + auto-restart on real crash
mkdir -p /etc/systemd/system/pips-sui.service.d
cat > /etc/systemd/system/pips-sui.service.d/memory.conf <<'EOF'
[Service]
MemoryHigh=15G
MemoryMax=18G
Restart=always
RestartSec=5
TimeoutStopSec=300
EOF

# Drop any scheduled restart. A periodic restart is another chance to flush mid-bloat and corrupt;
# with the cap the node never bloats, so we rely on the cap, not a timer.
systemctl disable --now pips-sui-restart.timer 2>/dev/null || true
rm -f /etc/systemd/system/pips-sui-restart.service /etc/systemd/system/pips-sui-restart.timer

systemctl daemon-reload
systemctl show pips-sui -p MemoryHigh -p MemoryMax -p Restart -p TimeoutStopUSec
```

**This supersedes the older "cap + nightly 04:00 restart" guardrail.** The conclusion now is that the cap alone is safer: a scheduled restart is just another bloated-flush risk. Keep this in mind if you've documented the nightly timer elsewhere.

**Rule going forward:** never `systemctl restart pips-sui` while it's bloated. With the cap it never bloats, so a restart is always a clean flush, exactly like a laptop. (Caveat: a hard `MemoryMax` OOM-kill is still a SIGKILL with no clean flush, so the cap lowers the odds, it does not make corruption impossible. The reversible reset below is the recovery.)

---

## Phase 1: Reset the chain (reversible)

```bash
# 1. Stop the node (synchronous; waits for it to exit and flush, up to TimeoutStopSec)
systemctl stop pips-sui

# 2. Move the chain DBs aside (NOT deleted yet, so we can roll back)
cd /opt/pips-sui
mv authorities_db authorities_db.OLD
mv consensus_db   consensus_db.OLD
mv full_node_db   full_node_db.OLD

# 3. Start fresh from the existing genesis
systemctl start pips-sui
sleep 10

# 4. Verify a clean chain
systemctl is-active pips-sui
echo "--- chain id (must still be 325c13db) ---"
curl -s -X POST http://127.0.0.1:9000 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"sui_getChainIdentifier","params":[]}'; echo
echo "--- checkpoint (should be low / fresh) ---"
curl -s -X POST http://127.0.0.1:9000 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"sui_getLatestCheckpointSequenceNumber","params":[]}'; echo
echo "--- operator re-funded by genesis? ---"
curl -s -X POST http://127.0.0.1:9000 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"suix_getAllBalances","params":["0xec9b41a3d2cdebad90c1e02c962a8a6a5fe1679972fc79c08ef10f7095df537e"]}'; echo
```

**Expect:** active, chain id `325c13db`, a low checkpoint number, operator holding ~150M SUI again. If the chain id changed, genesis was lost, do not proceed, roll back.

If all good, reclaim the disk:
```bash
rm -rf /opt/pips-sui/*.OLD
```

If it did NOT boot clean, see **Rollback** at the bottom.

---

## Phase 2: Redeploy Predict onto the clean chain

The CLI publishes over gRPC, which the proxied url blocks. `localnet.sh` handles that via the origin automatically.

> **The deployer-key trap (read this).** `scripts/localnet.sh setup`/`redeploy` always imports `backend/.env` `TESTING_WALLET_PK` and switches the sui CLI to *that* address before publishing. So a manual `sui client switch` does nothing, setup re-switches. The address that signs the publish is whatever `TESTING_WALLET_PK` decodes to, and on a fresh chain only the **genesis** key has gas. Therefore:
> - On the **server**, `backend/.env` `TESTING_WALLET_PK` is the genesis key (`0xec9b41a3…537e`), so deploy works.
> - From a **laptop**, `TESTING_WALLET_PK` is usually a different follower key with no gas on this chain, so the publish fails for no gas. Set `TESTING_WALLET_PK` to the genesis key first (it lives in `/opt/pips-sui/sui.keystore`).
>
> The wizard checks the resolved operator's balance on this chain **before** publishing and refuses with this guidance if it's unfunded.

```bash
# What the deploy will actually sign as, and whether it has gas on the fresh chain:
scripts/localnet.sh doctor    # derives the operator from TESTING_WALLET_PK, checks node/gRPC/funding
```

`doctor` reports the resolved operator and whether it's funded. If it says the operator is low/unfunded, fix the key per the trap above, do not publish.

Then, from the repo root:

```bash
scripts/localnet.sh redeploy     # force-republishes Predict + DUSDC, reseeds the vault, makes the oracle,
                                 # and writes the new ids into backend/src/lib/sui/deployed.localnet.json
scripts/localnet.sh status       # confirms the package is live on the chain
```

> Use `redeploy` (a forced fresh publish), not plain `setup`. `setup` *also* works here, because the bootstrap checks whether the old package is live on-chain and re-publishes when it isn't, but `redeploy` is the unambiguous "I want a fresh deploy" command.

Grab the fresh file, you need it for Phase 3:
```bash
cat backend/src/lib/sui/deployed.localnet.json
```

---

## Phase 3: Point the deployed backend at the new ids (one env var)

Your Dokploy backend reads the entire deployment from `PIPS_DEPLOYED_JSON` (see `backend/src/lib/sui/config.ts`, `loadDeployed`). So:

1. Copy the full contents of the new `deployed.localnet.json` (or base64 it).
2. In Dokploy → the backend service → Environment, set:
   ```
   PIPS_DEPLOYED_JSON=<paste the full JSON, or base64 of it>
   ```
   (base64 avoids newline issues: `base64 backend/src/lib/sui/deployed.localnet.json | tr -d '\n'`)
3. Make sure `SUI_NETWORK=localnet` and `SUI_FULLNODE_URL=https://rpc.playpips.fun` are still set.
4. Redeploy/restart the backend service.

`config.ts` will throw on boot if `PIPS_DEPLOYED_JSON`'s `network` doesn't match `SUI_NETWORK`, so a mismatch fails fast rather than running on stale ids.

---

## Phase 4: Frontend (rebuild with the new ids)

The frontend bakes `VITE_PREDICT_*` / `VITE_DUSDC_TYPE` at build time, and those ids changed (chain id did not). Wherever the frontend is hosted:

- Update `VITE_PREDICT_PACKAGE_ID` (= `packageId`), `VITE_PREDICT_OBJECT_ID` (= `predictId`), `VITE_DUSDC_TYPE` (= `dusdc.type`). Values are in the new `deployed.localnet.json`.
- `VITE_SUI_FULLNODE_URL` / `VITE_SUI_NETWORK` stay the same.
- **Rebuild + redeploy** the frontend (Vite env is compile-time, a restart alone won't pick it up).

---

## Phase 5: Re-fund users (so they can play again)

After a chain reset every user's on-chain manager, DUSDC chips, and SUI gas are gone, and onboarding is flag-locked so it won't auto-heal. Clearing the flags re-arms each user, and the existing onboarding (`backend/src/services/auth.ts` → `provisionUser`) re-provisions them **lazily on their next login** (new manager + fresh starting DUSDC + fresh gas).

The script ships at `backend/scripts/reprovision-users.ts` (it clears `predictManagerId`, `dusdcFunded`, and `suiGasFunded`). Run it from `backend/`:

```bash
cd backend && bun scripts/reprovision-users.ts
```

No real funds are involved (free localnet DUSDC). User accounts, usernames, and logins are untouched. Chips are paid from the treasury reserve, which the operator's `ops-funding` worker refills on the fresh chain; until it does, onboarding falls back to a direct operator mint, so re-provision never hard-fails.

### Optional: wipe play history for a clean slate
Stats are derived from the `Play` ledger, so clearing it resets stats too. The guarded script is `backend/scripts/wipe-history.ts` (clears plays, the legacy `UserStats` counters, achievement unlocks, and minigame scores; keeps `User` rows so logins survive):
```bash
cd backend && bun scripts/wipe-history.ts --confirm
```

---

## Phase 6: End-to-end verify

```bash
# chain healthy + package live
scripts/localnet.sh status

# proxied url reachable + right chain (what the apps use)
curl -s https://rpc.playpips.fun -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"sui_getChainIdentifier","params":[]}'; echo
```

Then open the app, log in as a test user (triggers re-provision), confirm the DUSDC balance shows and a play works.

---

## Rollback (if Phase 1 didn't boot clean)

The old DBs are still there as `*.OLD`. Restore them (or run `scripts/localnet-refresh.sh rollback`):
```bash
systemctl stop pips-sui
cd /opt/pips-sui
rm -rf authorities_db consensus_db full_node_db
mv authorities_db.OLD authorities_db
mv consensus_db.OLD   consensus_db
mv full_node_db.OLD   full_node_db
systemctl start pips-sui
```
That puts you back exactly where you started (the replay state), no worse off.

---

## One-glance checklist

- [ ] Preflight: disk has room, repo + genesis deploy key reachable
- [ ] Phase 0: guardrails applied (cap + 300s stop + no timer)
- [ ] Phase 1: chain reset, id still `325c13db`, operator funded, `.OLD` removed
- [ ] Phase 2: deploy key is genesis-funded, `localnet.sh redeploy` done, package live
- [ ] Phase 3: `PIPS_DEPLOYED_JSON` updated in Dokploy, backend restarted
- [ ] Phase 4: frontend `VITE_*` updated + rebuilt
- [ ] Phase 5: `reprovision-users.ts` run
- [ ] Phase 6: log in, balance shows, play works
