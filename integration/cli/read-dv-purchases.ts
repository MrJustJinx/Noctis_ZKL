// ============================================================================
// Noctis Protocol — Tier B: read-dv-purchases CLI (T76/T112)
// ============================================================================
// PHP<->Node bridge, same convention as check-cto-badge-status.ts and every
// other CLI in this directory: real logic lives in read-dv-purchases.ts;
// this script is a thin stdin/stdout wrapper.
//
// Input: single JSON object on stdin. Output: single JSON object on
// stdout, exit 0 on success (a not-yet-deployed contract, `deployed:
// false`, counts as success — the query itself completed), non-zero with
// {"error": "..."} on any failure the caller couldn't complete.
// ============================================================================

import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { readDvPurchases } from '../read-dv-purchases.js';

interface ReadDvPurchasesInput {
  indexerUri: string;
  indexerWsUri: string;
  contractAddressHex: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const raw = await readStdin();
  let input: ReadDvPurchasesInput;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON on stdin.');
  }

  const required: Array<keyof ReadDvPurchasesInput> = ['indexerUri', 'indexerWsUri', 'contractAddressHex'];
  for (const key of required) {
    if (!input[key]) {
      throw new Error(`Missing required field: ${key}`);
    }
  }

  const publicDataProvider = indexerPublicDataProvider(input.indexerUri, input.indexerWsUri);
  const result = await readDvPurchases(publicDataProvider, input.contractAddressHex);

  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
