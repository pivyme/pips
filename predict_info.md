# How PIPS trades on DeepBook Predict

A plain-english cheat sheet for the parts judges usually ask about. No fluff.

---

## What's actually happening under the hood

Every play in PIPS is a **real on-chain trade** on Sui, using **Mysten's official DeepBook Predict**. We don't run our own market or fake any prices. We just make it feel like a game on top.

Predict only knows how to do two things:

- **Up / Down** — will BTC be above or below a price at the buzzer?
- **Range** — will BTC land *inside* a price band at the buzzer?

That's it. Every PIPS game is built out of those two. RANGE uses the band one: you win `$1 per unit` if BTC is inside your band when the round ends, otherwise `$0`. The final price is set by **Pyth** (the oracle) at expiry, not by us.

---

## The one thing everything else depends on: rounds are Mysten's, not ours

Mysten runs a steady stream of **1-minute BTC rounds**. New round every minute, always. **PIPS doesn't own the clock, we just hop onto Mysten's rounds.** Our backend reads the live rounds off the chain every 2 seconds so the game always knows which one is open.

Two questions come straight out of this.

---

## "I placed a bet a few seconds before the cutoff, but it went into the *next* round?"

Yep, on purpose.

When you tap, we **don't** shove you into a round that's about to end. If the current round has less than ~20 seconds left, we skip it and put you in the next fresh one.

Why? A round with 6 seconds left is basically already decided. The price can't move much, so the payout collapses to almost nothing while the screen was promising you a real multiplier. That's a bad deal. So instead of handing you a dud, we roll you into the next full round where the payout you were shown actually holds up.

Think of it like a bus. You just missed this one, so we put you on the next one so the ride is actually worth taking. Your countdown just shows a bit longer, that's all.

---

## "The band shows up instantly, is that a real on-chain value or fake?"

It's real. Here's the honest version of why it's so fast.

**The band is built from a live chain read the moment you tap:**

- The **center** of the band is BTC's live on-chain oracle price, pulled fresh right when you tap. Not a made-up number, not a stale one.
- The **width** of the band comes from how likely your tier is to win, calibrated against how the chain *actually* prices these trades (we constantly test-price real trades in the background to stay honest to the market).

**Why it feels instant:** we show you the band immediately, then the actual trade confirms on-chain about a second later in the background. Once it lands, the numbers **snap to the exact on-chain values**. So you're not waiting on a spinner, but nothing shown is invented, it's an accurate preview that locks to the real thing a beat later.

**And the important part:** everything that decides whether you win or lose, the entry price, the band edges, the final price, all of it is read from the chain. The chart line you watch moves smoothly (we borrow Binance's ticks just for smooth motion), but the number that *settles* your bet is always the on-chain oracle. The win/lose reveal snaps to the true settlement price.

---

## If a judge presses you, say this

> The band you see is a real quote, centered on BTC's live on-chain price the instant you tap. It shows instantly because we preview it while the actual trade confirms on-chain about a second later, then it snaps to the exact position. Entry, band, and settlement are all read from the chain. Nothing about the outcome is client-side.

Two things worth owning up front so it looks like rigor, not a gap:

- **The payout multiplier is a preview until the trade lands, then it snaps.** The band itself is basically exact (it's just the live price plus/minus a width we already know). Only the exact multiple is finalized by the chain when the trade confirms. That's also why RANGE runs at 1x leverage: the outcome stays clean and simple, "inside the band = you win ~1/probability," with no mid-round liquidation surprises.
- **The band edges shown are rounded a hair from the on-chain ones.** The chain snaps bands to a $1 grid, so the displayed edge can be off by well under a dollar. It's cosmetic, it never changes who wins.

---

## Where this lives in the code (if anyone wants to verify)

- `backend/src/lib/sui/predict-real.ts` — all the real on-chain Predict calls
- `backend/src/services/games-real.ts` — round routing + band/price math
- `backend/src/services/plays.ts` — the place-bet → confirm → settle flow
- `backend/src/workers/market-sync.ts` — reads Mysten's live rounds off-chain
- `web/src/routes/_app/games/range.tsx` — the RANGE screen
