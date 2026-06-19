# Pips Contracts (Sui Move)

On-chain logic for Pips. This is the third pillar of the monorepo alongside `web/` and `backend/`.

## What lives here

Sui Move packages for:
- **Game logic** — rounds, plays, scoring, leaderboards, payout/escrow where a game needs on-chain state.
- **DeepBook Predict composition** — thin wrappers and PTB helpers so each game settles cleanly against DeepBook Predict. Predict is an external on-chain protocol, we compose with it, we do not reimplement it.

Keep packages small and focused. One concern per module. The fun lives in the frontend, the chain holds truth and value.

## Status

Four vendored packages, published as one self-owned Predict stack onto our localnet:

```
contracts/
├── token/      # the deepbook governance token dep
├── deepbook/   # vendored DeepBook v3 core (links predict)
├── predict/    # our copy of packages/predict (the markets, vault, oracles)
└── dusdc/      # our own freely-mintable DUSDC (the quote asset / vault seed)
```

`predict` links `deepbook` by local path, `deepbook` links `token`. They publish leaf-first (`token` -> `deepbook` -> `predict`) because unpublished deps cannot all share `0x0`. The whole bootstrap is automated, see "How they get deployed" below, you rarely build a package by hand.

## How they get deployed

These do not go to Sui testnet. They publish onto **our own Sui localnet** (live at `https://rpc.playpips.fun`) via the repo-root front door:

```bash
scripts/localnet.sh setup        # first time: publish the stack + seed the vault + wire both .envs
scripts/localnet.sh redeploy     # after ANY change in here: republish + reseed (ids change)
scripts/localnet.sh doctor       # is the package live on chain? operator funded?
```

`redeploy` is the loop for Move work. It runs `backend/scripts/bootstrap.ts`, which publishes with `sui client test-publish` (the localnet path), seeds, and rewrites the ids in `backend/src/lib/sui/deployed.localnet.json` + both `.env`s. To build/test a single package in isolation while iterating: `cd contracts/predict && sui move build` / `sui move test`.

## Rules

- **Network is our own Sui localnet, not testnet.** Mysten's Predict is testnet only as of mid 2026; we never depend on it, we publish our own copy here. Mainnet is a clean re-point later. The deploy gRPC-origin gotcha is documented in the root [`../CLAUDE.md`](../CLAUDE.md) ("The chain").
- **Never hardcode package IDs or object addresses in app code.** Every `redeploy` changes them. Publish output is the single source of truth (`deployed.localnet.json`, read via backend `config.ts` and web `env.ts`).
- **DeepBook is vendored locally** (`contracts/deepbook`), linked by path, not via Move Registry. MVR `@deepbook/core` is not used (resolver binary not installed, version drift risk). The legacy `deepbook` system package is v2 and deprecated, do not use it.
- **Do not add `localnet` to `Move.toml` `[environments]`** and do not `sui client publish` for it (CLI 1.71 rejects: "the package does not define a `local` environment"). The localnet path is `sui client test-publish`, which the bootstrap drives and cleans up after (it restores the ephemeral `Move.lock` pins so git stays clean).
- `Move.toml` and `Move.lock` are committed. `build/` is gitignored.
- Choose the upgrade policy deliberately at publish time. Do not leave it accidental.

## Before writing Move

Confirm the current DeepBook Predict module surface against the vendored source in `predict/sources/` and the live docs (`docs.sui.io/onchain-finance/deepbook-predict/`). The protocol is pre mainnet and changing. Do not code against remembered APIs. After a change, `scripts/localnet.sh redeploy` to put it on the localnet.
