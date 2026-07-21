// Trustless PIPS volume proof: PIPS's Played event identifies the transaction, while every monetary
// value is read from Predict's co-located OrderMinted event. Run with `bun run pips:proof -- --csv out.csv`.

import '../dotenv.ts';

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { PIPS_LOGGER_PACKAGE_ID, SUI_NETWORK } from '../src/config/main-config.ts';
import { graphqlClient } from '../src/lib/sui/client.ts';
import { formatDusdcRaw } from '../src/lib/sui/config.ts';
import { decodeOrderId, parseMint, type RealEvent } from '../src/lib/sui/predict-real.ts';

type Json = Record<string, unknown>;
type GraphEvent = {
  contents: { json: Json | null } | null;
  transaction: {
    digest: string;
    effects: {
      events: {
        nodes: Array<{ contents: { json: Json | null; type: { repr: string } | null } | null }>;
      } | null;
    } | null;
  } | null;
};
type EventPage = {
  events: { pageInfo: { hasPreviousPage: boolean; startCursor: string | null }; nodes: GraphEvent[] };
};

export type ProofPlay = {
  digest: string;
  player: string;
  game: string;
  playId: string;
  market: string;
  referrerId: string;
  premiumRaw: bigint;
  notionalRaw: bigint;
};

export type VolumeProof = {
  packageId: string;
  plays: ProofPlay[];
  premiumRaw: bigint;
  notionalRaw: bigint;
  uniquePlayers: number;
  byGame: Record<string, { plays: number; premiumRaw: bigint; notionalRaw: bigint }>;
  byReferrer: Record<string, { plays: number; premiumRaw: bigint; notionalRaw: bigint }>;
};

const PLAYED_QUERY = `query($type: String!, $last: Int!, $before: String) {
  events(last: $last, before: $before, filter: { type: $type }) {
    pageInfo { hasPreviousPage startCursor }
    nodes {
      contents { json }
      transaction {
        digest
        effects { events(first: 50) { nodes { contents { json type { repr } } } } }
      }
    }
  }
}`;

const asString = (json: Json, key: string): string => {
  const value = json[key];
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`Played event missing ${key}`);
  return String(value);
};

function deployedPackageId(): string {
  if (PIPS_LOGGER_PACKAGE_ID) return PIPS_LOGGER_PACKAGE_ID;
  try {
    const record = JSON.parse(readFileSync(resolve(import.meta.dir, `../../contracts/pips_logger/deployed.${SUI_NETWORK}.json`), 'utf8')) as {
      packageId?: unknown;
    };
    return typeof record.packageId === 'string' ? record.packageId : '';
  } catch {
    return '';
  }
}

function proofPlayFromEvent(event: GraphEvent): ProofPlay {
  const json = event.contents?.json;
  const tx = event.transaction;
  if (!json || !tx?.digest) throw new Error('Played event is missing its transaction or parsed payload');
  const orderEvents: RealEvent[] = (tx.effects?.events?.nodes ?? []).flatMap((event) => {
    const contents = event.contents;
    return contents?.type?.repr ? [{ type: contents.type.repr, parsedJson: contents.json }] : [];
  });
  const minted = parseMint(orderEvents);
  return {
    digest: tx.digest,
    player: asString(json, 'player'),
    game: asString(json, 'game'),
    playId: asString(json, 'play_id'),
    market: asString(json, 'market'),
    referrerId: asString(json, 'referrer_id'),
    // This is Predict's all-in order cost, not a number supplied by PIPS.
    premiumRaw: minted.costRaw,
    notionalRaw: minted.quantityRaw,
  };
}

export function aggregateProof(packageId: string, plays: ProofPlay[]): VolumeProof {
  const byGame: VolumeProof['byGame'] = {};
  const byReferrer: VolumeProof['byReferrer'] = {};
  let premiumRaw = 0n;
  let notionalRaw = 0n;
  for (const play of plays) {
    premiumRaw += play.premiumRaw;
    notionalRaw += play.notionalRaw;
    const game = (byGame[play.game] ??= { plays: 0, premiumRaw: 0n, notionalRaw: 0n });
    game.plays++;
    game.premiumRaw += play.premiumRaw;
    game.notionalRaw += play.notionalRaw;
    if (play.referrerId) {
      const referrer = (byReferrer[play.referrerId] ??= { plays: 0, premiumRaw: 0n, notionalRaw: 0n });
      referrer.plays++;
      referrer.premiumRaw += play.premiumRaw;
      referrer.notionalRaw += play.notionalRaw;
    }
  }
  return { packageId, plays, premiumRaw, notionalRaw, uniquePlayers: new Set(plays.map((play) => play.player)).size, byGame, byReferrer };
}

export async function scanPipsVolume(packageId = deployedPackageId()): Promise<VolumeProof> {
  if (!packageId) throw new Error('PIPS_LOGGER_PACKAGE_ID is unset and no deployed logger record exists for this network');
  const seenDigests = new Set<string>();
  const plays: ProofPlay[] = [];
  let before: string | null = null;
  for (;;) {
    const result: { data?: unknown; errors?: unknown } = await graphqlClient.query({
      query: PLAYED_QUERY,
      variables: { type: `${packageId}::activity::Played`, last: 50, before },
    });
    if (result.errors) throw new Error(`GraphQL event scan failed: ${JSON.stringify(result.errors)}`);
    const page = (result.data as EventPage | undefined)?.events;
    if (!page) throw new Error('GraphQL event scan returned no events connection');
    for (const event of page.nodes) {
      const play = proofPlayFromEvent(event);
      if (!seenDigests.has(play.digest)) {
        seenDigests.add(play.digest);
        plays.push(play);
      }
    }
    if (!page.pageInfo.hasPreviousPage || !page.pageInfo.startCursor) break;
    before = page.pageInfo.startCursor;
  }
  return aggregateProof(packageId, plays);
}

const csvCell = (value: string): string => `"${value.replaceAll('"', '""')}"`;
export function proofCsv(proof: VolumeProof): string {
  const header = 'tx_digest,player,game,play_id,market,referrer_id,premium_usd,notional_usd';
  const rows = proof.plays.map((play) => [
    play.digest,
    play.player,
    play.game,
    play.playId,
    play.market,
    play.referrerId,
    formatDusdcRaw(play.premiumRaw),
    formatDusdcRaw(play.notionalRaw),
  ].map(csvCell).join(','));
  return `${header}\n${rows.join('\n')}\n`;
}

export async function reconcileProofWithDb(proof: VolumeProof, closeClient = false): Promise<void> {
  const { prismaQuery } = await import('../src/lib/prisma.ts');
  try {
    const ids = proof.plays.map((play) => play.playId);
    const rows = await prismaQuery.play.findMany({
      where: { id: { in: ids } },
      select: { id: true, txMint: true, entryCost: true, rake: true, marketKey: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const proofPlay of proof.plays) {
      const row = byId.get(proofPlay.playId);
      if (!row) throw new Error(`DB reconciliation missing play ${proofPlay.playId}`);
      if (row.txMint !== proofPlay.digest) throw new Error(`DB reconciliation digest mismatch for ${proofPlay.playId}`);
      if (row.entryCost - row.rake !== proofPlay.premiumRaw) {
        throw new Error(`DB reconciliation premium mismatch for ${proofPlay.playId}`);
      }
      if (!row.marketKey || decodeOrderId(BigInt(row.marketKey)).quantityRaw !== proofPlay.notionalRaw) {
        throw new Error(`DB reconciliation quantity mismatch for ${proofPlay.playId}`);
      }
    }
  } finally {
    if (closeClient) await prismaQuery.$disconnect();
  }
}

function displaySummary(proof: VolumeProof) {
  return {
    network: SUI_NETWORK,
    packageId: proof.packageId,
    headline: 'premium',
    premium: formatDusdcRaw(proof.premiumRaw),
    notional: formatDusdcRaw(proof.notionalRaw),
    playCount: proof.plays.length,
    uniquePlayers: proof.uniquePlayers,
    byGame: Object.fromEntries(Object.entries(proof.byGame).map(([game, values]) => [game, {
      plays: values.plays,
      premium: formatDusdcRaw(values.premiumRaw),
      notional: formatDusdcRaw(values.notionalRaw),
    }])),
    byReferrer: Object.fromEntries(Object.entries(proof.byReferrer).map(([referrer, values]) => [referrer, {
      plays: values.plays,
      premium: formatDusdcRaw(values.premiumRaw),
      notional: formatDusdcRaw(values.notionalRaw),
    }])),
  };
}

if (import.meta.main) {
  const csvArg = process.argv.find((arg) => arg.startsWith('--csv='));
  const reconcile = process.argv.includes('--reconcile-db');
  const proof = await scanPipsVolume();
  if (reconcile) await reconcileProofWithDb(proof, true);
  const csvPath = resolve(process.cwd(), csvArg?.slice('--csv='.length) || 'pips-volume-proof.csv');
  mkdirSync(dirname(csvPath), { recursive: true });
  writeFileSync(csvPath, proofCsv(proof));
  console.log(JSON.stringify({ ...displaySummary(proof), csv: csvPath, dbReconciled: reconcile }, null, 2));
}
