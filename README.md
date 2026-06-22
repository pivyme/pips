<div align="center">

# PIPS

**A gamified trading console on Sui, powered by DeepBook Predict.**

[Play PIPS](https://playpips.fun)

</div>

[![PIPS gamified trading console](web/public/pips-thumbnail.png)](https://playpips.fun)

PIPS turns short-expiry prediction markets into games played through a virtual handheld console. The interface removes the usual charts, order forms, and wallet friction, while successful trading plays still mint and redeem real on-chain positions.

Users sign in with Google or email. Privy provisions an embedded ed25519 Sui wallet, the backend creates a `PredictManager`, and gas sponsorship removes the need to hold SUI.

## Games

- **I Feel Lucky:** A seeded reel deals an asset, direction, and payout tier. PIPS finds the live strike whose real Predict price is closest to that tier, then mints an up or down binary position.
- **Range:** Choose how tightly the asset price must finish around its current value. The bounds are snapped to the oracle strike grid and quoted directly from Predict. Tighter bands generally return a higher multiple.
- **Line Rider and Candle Hop:** Arcade side games with score-based leaderboards. These do not create trading positions.

Lucky and Range support early cash-out at the protocol's live bid. Holding through expiry returns the full contract payout when the position finishes in the money, or zero when it does not.

## DeepBook Predict integration

PIPS uses the two instruments exposed by DeepBook Predict:

| PIPS game | Predict position | Settlement rule |
| --- | --- | --- |
| Lucky | Binary `MarketKey` | Up wins above the strike. Down wins at or below it. |
| Range | Vertical `RangeKey` | Wins when the settlement price is inside `(lower, upper]`. |

Positions are balances inside each user's shared `PredictManager`, not frontend simulations or position NFTs.

### Trade lifecycle

1. **Maintain live markets.** The operator keeps a staggered ladder of short-lived `OracleSVI` objects for BTC, ETH, and SUI. A worker creates and activates new oracles before older ones expire.
2. **Push one consistent price.** Pyth provides the real market anchor. PIPS adds a bounded, mean-reverting volatility layer so a 20 to 30 second round has meaningful movement. The chart, Predict oracle, and settlement worker all consume the same feed, so the price shown to the player is the price used on-chain.
3. **Quote on-chain.** The backend calls Predict's `get_trade_amounts` and `get_range_trade_amounts` through `devInspect`. Lucky batches a dense strike scan to find a mintable target multiple. Range batches its band previews so the displayed payout is based on the current Predict ask, not a hardcoded odds table.
4. **Mint atomically.** A programmable transaction block deposits DUSDC into the user's manager when needed, then calls `predict::mint` or `predict::mint_range`. If the mint fails, the deposit and trade revert together.
5. **Sign without popups.** In the Privy path, the backend builds the transaction and requests an intent-safe `rawSign` from the user's embedded wallet through a session signer. When sponsorship is enabled, the gas sponsor co-signs the same transaction bytes.
6. **Cash out or settle.** Before expiry, `redeem` or `redeem_range` exits at the live bid. After expiry, an authorized price push freezes the oracle's settlement price. Winning positions are redeemed permissionlessly into the user's manager; losing positions settle at zero.

Multipliers are derived from the position quantity divided by its real mint cost. Predict prices entry at the ask and early exit at the bid, so spread and vault exposure remain part of the game rather than being hidden by the UI.

### Devnet deployment

The hackathon build is deployed on **Sui Devnet**. PIPS publishes its own DeepBook Predict stack instead of depending on a shared Predict instance:

```text
DUSDC quote asset
DEEP token dependency -> DeepBook core -> DeepBook Predict
```

The bootstrap publishes the Move packages, creates the shared Predict object and vault, seeds DUSDC liquidity, creates operator capabilities, verifies a mint/redeem round trip, and writes the generated package and object IDs into backend and frontend configuration.

Current Devnet deployment, verified June 22, 2026:

```text
Predict package   0x22cd61a00bbe305a22f6ff3d4860c87da69cc2149cc8f4b1d0e6379ef6a52e2d
Predict registry  0x33fc49dac0e4b8d2e2d8404472fbba28d614a68db17968e2474ece5213d4c956
Predict object    0x07a9e74f122bd14ea9d973d7e825fb6fa0e94da36f4481304f870d14ca1cc40d
Predict AdminCap  0xf3cf2684060e19fa59c50b99cb93e8cd97aa9bd9de8a0711ee9d98d2611b5739

DeepBook package  0xce7913ee1e5341c1f890b1b79555052927c21c4dcdff2c1e35aea56907c40d0
DEEP package      0x5fa42125b719c220b8f126e856badc5f0fb6b8128e0fc1dd3c1ff6b9393381cb
DUSDC package     0x3d5d01c4e4d081706fcd9f79114fba2bb839b687501810dab43bb078531416dd
DUSDC type        0x3d5d01c4e4d081706fcd9f79114fba2bb839b687501810dab43bb078531416dd::dusdc::DUSDC
```

DUSDC is the test quote asset used for positions and payouts. DEEP is included because DeepBook core depends on it; players do not wager DEEP.

This deployment gives PIPS control over short expiries, oracle cadence, test liquidity, and settlement while preserving the actual Predict pricing, vault, manager, mint, and redeem flow. Devnet can reset and every redeploy generates new IDs, so runtime reads the bootstrap deployment record instead of hardcoding addresses in application logic.

For fully reproducible local development, the same stack can also be deployed to a private Sui localnet with `scripts/localnet.sh setup`. Neither environment uses mainnet funds.

## Architecture

```text
React console
  | HTTP + SSE
Fastify API
  | quote, build, sign, submit
Sui programmable transactions
  | mint, redeem, oracle updates
DeepBook Predict

Operator workers: Pyth anchor -> price push -> oracle roll -> expiry settlement
PostgreSQL: users, play metadata, achievements, stats, and leaderboards
```

- **Frontend:** TanStack Start, React 19, Three.js, Tailwind CSS, HeroUI, Motion, and Web Audio.
- **Backend:** Bun, Fastify, Prisma, PostgreSQL, Privy, Pyth Hermes, and `@mysten/sui`.
- **Contracts:** Sui Move packages for DeepBook core, DeepBook Predict, DUSDC, and the DEEP token dependency.
- **Realtime:** SSE streams carry market prices and play state while on-chain transactions remain the source of truth for positions and payouts.

The Sui integration is isolated behind one transaction wrapper. Games never construct raw Move calls or depend directly on deployment IDs.

## Repository

```text
web/          Console UI, games, auth, API client, and realtime streams
backend/      Game resolution, Predict PTBs, signing, workers, and persistence
contracts/    Vendored and configured Sui Move packages
scripts/      Localnet deployment and diagnostics
docs/         Product flow and design system
```

## Run locally

Requirements: Bun, PostgreSQL, the Sui CLI, and the environment values documented in `backend/.env.example` and `web/.env.example`.

```bash
cp backend/.env.example backend/.env
cp web/.env.example web/.env

cd backend
bun install
bun run db:push

cd ../web
bun install

cd ..
scripts/localnet.sh setup
```

Start the API and frontend in separate terminals:

```bash
cd backend && bun dev
cd web && bun dev
```

Useful checks:

```bash
cd contracts/predict && sui move test
cd backend && bun test && bun run typecheck
cd web && bun test && bun run build
```

## Sui Overflow 2026

PIPS is a submission for **Sui Overflow 2026**.

Try it at [playpips.fun](https://playpips.fun).

## Contact

[Kelvin Adithya on Telegram](https://t.me/KelvinAdithya)
