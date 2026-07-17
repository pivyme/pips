// One pure function drives the entire deposit drawer, so there is no branching UI state the player can
// get stuck in: pick a currency and a network, and the mode falls out.

export type DepositMode = 'receive' | 'bridge' | 'unsupported'

// The chip asset on Sui needs no bridge, the address just receives it. Everything else routes through
// LI.FI. A non-chip asset on Sui is the one dead pair: LI.FI has no Sui source routes, so a Sui-native
// swap leg would be a direct Cetus/Aftermath integration, not this.
export function resolveMode(currency: string, network: string, chipSymbol: string): DepositMode {
  if (network === 'sui') return currency === chipSymbol ? 'receive' : 'unsupported'
  return 'bridge'
}

// `unsupported` is never a dead end, it is a labelled state with a reason the player can act on.
export function unsupportedCopy(chipSymbol: string): string {
  return `Only ${chipSymbol} on Sui tops up your balance today.`
}

// Display names for the source chains. The catalog itself is server-owned (GET /deposit/options); this is
// presentation only, and an unknown key degrades to the key rather than blanking the row.
const NETWORK_LABELS: Record<string, string> = {
  sui: 'Sui',
  ethereum: 'Ethereum',
  base: 'Base',
  arbitrum: 'Arbitrum',
  solana: 'Solana',
}

export const networkLabel = (network: string): string => NETWORK_LABELS[network] ?? network

// "~20 min" / "~45s", from the quote's real executionDuration. Never hardcode this: the same catalog
// spans 60s (allbridge) to 1200s (mayanMCTP) depending on which tool wins the route.
export function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—'
  if (seconds < 90) return `~${seconds}s`
  return `~${Math.round(seconds / 60)} min`
}
