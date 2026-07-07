// Tiny gRPC read helper for scripts/devnet-refresh.sh. JSON-RPC is deprecated, so the shell's chain
// reads (chain id, SUI balance, package existence) go through SuiGrpcClient instead of raw curl
// against the JSON-RPC methods. Output is plain (one value per line) so bash parses it with no jq.
//
// Run from backend/ (where @mysten/sui is installed): `cd backend && bun ../scripts/sui-grpc.ts ...`.
// RPC url resolves from --rpc <url>, then $SUI_FULLNODE_URL, then $PIPS_DEVNET_RPC, then the devnet
// default. Exit 0 on success; a missing object exits 3 and prints `notExists`.

import { SuiGrpcClient } from '@mysten/sui/grpc';

const SUI_TYPE = '0x2::sui::SUI';
const DEFAULT_RPC = 'https://fullnode.devnet.sui.io:443';

function resolveRpc(args: string[]): string {
  const i = args.indexOf('--rpc');
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return process.env.SUI_FULLNODE_URL || process.env.PIPS_DEVNET_RPC || DEFAULT_RPC;
}

function isNotFound(e: unknown): boolean {
  return (e instanceof Error ? e.message : String(e)).toLowerCase().includes('not found');
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2).filter((a, idx, all) => {
    // Drop the --rpc flag + its value from the positional args.
    if (a === '--rpc') return false;
    if (idx > 0 && all[idx - 1] === '--rpc') return false;
    return true;
  });
  const cmd = argv[0];
  const client = new SuiGrpcClient({ network: 'devnet', baseUrl: resolveRpc(process.argv.slice(2)) });

  switch (cmd) {
    case 'chain-id': {
      const { chainIdentifier } = await client.core.getChainIdentifier();
      process.stdout.write(chainIdentifier + '\n');
      return 0;
    }
    case 'balance': {
      const owner = argv[1];
      if (!owner) throw new Error('balance: missing <address>');
      const coinType = argv[2] || SUI_TYPE;
      const { balance } = await client.getBalance({ owner, coinType });
      process.stdout.write(balance.balance + '\n');
      return 0;
    }
    case 'object': {
      const id = argv[1];
      if (!id) throw new Error('object: missing <id>');
      try {
        const { object } = await client.getObject({ objectId: id });
        process.stdout.write((object.type || 'exists') + '\n');
        return 0;
      } catch (e) {
        if (isNotFound(e)) {
          process.stdout.write('notExists\n');
          return 3;
        }
        throw e;
      }
    }
    default:
      throw new Error(`unknown command '${cmd ?? ''}'. Use: chain-id | balance <addr> [coinType] | object <id>`);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    // Match the old curl helpers' quiet failure: a read error prints nothing to stdout (so the shell
    // sees an empty value and treats it as unreachable/zero), the reason goes to stderr, exit 1.
    process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n');
    process.exit(1);
  });
