# Pips Contracts (Sui Move)

On-chain logic for Pips. This is the third pillar of the monorepo alongside `web/` and `backend/`.

## What lives here

Sui Move packages for:
- **Game logic** — rounds, plays, scoring, leaderboards, payout/escrow where a game needs on-chain state.
- **DeepBook Predict composition** — thin wrappers and PTB helpers so each game settles cleanly against DeepBook Predict. Predict is an external on-chain protocol, we compose with it, we do not reimplement it.

Keep packages small and focused. One concern per module. The fun lives in the frontend, the chain holds truth and value.

## Status

Not scaffolded yet. When starting the first package:

```bash
sui move new pips         # scaffold a package
cd pips
sui move build
sui move test
```

Suggested layout once it exists:

```
contracts/
└── pips/
    ├── Move.toml         # committed (pins deps + addresses)
    ├── Move.lock         # committed (locks resolved on-chain deps)
    ├── sources/          # Move modules
    └── tests/            # Move unit tests
```

## Rules

- **Network is Sui testnet for now.** DeepBook Predict is testnet only as of mid 2026 and its package IDs are explicitly unstable. Plan a clean mainnet re-point.
- **Never hardcode package IDs or object addresses in app code.** Publish output goes into config (`web/src/config.ts`, backend config). One source of truth.
- **DeepBook v3 dependency** resolves via Move Registry: `deepbook = { mvr = "@deepbook/core" }`. The legacy `deepbook` system package is v2 and deprecated, do not use it.
- `Move.toml` and `Move.lock` are committed. `build/` is gitignored.
- Choose the upgrade policy deliberately at publish time. Do not leave it accidental.

## Before writing Move

Confirm the current DeepBook Predict module surface and package addresses against the live docs (`docs.sui.io/onchain-finance/deepbook-predict/`). The protocol is pre mainnet and changing. Do not code against remembered APIs.
