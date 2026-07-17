<div align="center">

# PIPS

**A gamified trading console on Sui, powered by DeepBook Predict.**

[Play PIPS](https://playpips.fun)

</div>

<img width="1600" height="900" alt="pips-FINAL_THUMBNAIL" src="https://github.com/user-attachments/assets/ea847ac7-9770-48ff-b373-755b0c609c24" />

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

Positions live inside each user's on-chain `AccountWrapper`, not frontend simulations or position NFTs.

### Trade lifecycle

1. **Discover live markets.** Mysten runs the DeepBook Predict markets and their oracles. PIPS reads the live 1-minute BTC markets straight from chain each tick; there is no operator or oracle ladder of ours.
2. **One consistent price.** Pyth is the on-chain anchor. The chart's motion rides a shared Binance feed, EMA-pinned to the market's on-chain spot, so the line the player watches tracks the price the round settles against. Every recorded number (entry, exit, settlement) reads the chain.
3. **Size the play.** The backend sizes a strike + leverage to a target win probability, mints, then reads the real minted multiplier back off the `OrderMinted` event (the real ask is unreadable before the mint).
4. **Mint atomically.** One sponsored programmable transaction block derives or creates the user's `AccountWrapper`, deposits the DUSDC shortfall, and mints. If the mint fails, the whole block reverts.
5. **Sign without popups.** In the Privy path the backend builds the transaction and requests an intent-safe `rawSign` from the user's embedded wallet through a session signer; the gas sponsor co-signs the same transaction bytes.
6. **Cash out or settle.** Before expiry, `redeem_live` exits at the live bid. After expiry, `redeem_settled` (permissionless) pays `$1 x quantity` for a win or zero for a loss, straight into the wrapper.

Multipliers are derived from the position quantity divided by its real mint cost. Predict prices entry at the ask and early exit at the bid, so spread and vault exposure remain part of the game rather than being hidden by the UI.

### Deployment

PIPS trades **Mysten's official DeepBook Predict** on **Sui testnet** (mainnet is a clean re-point of the same code). It does not publish or operate its own Predict: the market ids come from the committed deploy record (`backend/src/lib/sui/deployed-real.testnet.json`, re-fetched from chain, never hardcoded), chips are DUSDC from a hand-funded treasury (not mintable on a deployment we don't own), and gas is paid by a sponsor wallet. The vendored Predict fork under `contracts/` and the `scripts/localnet.sh` deploy scripts remain in the repo for reference only, not the run path. No mainnet funds are used on testnet.

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

Requirements: Bun and PostgreSQL, plus the environment values documented in `backend/.env.example` and `web/.env.example` (the testnet Predict ids are already committed, so there is no deploy step).

```bash
cp backend/.env.example backend/.env
cp web/.env.example web/.env

cd backend
bun install
bun run db:push

cd ../web
bun install
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
