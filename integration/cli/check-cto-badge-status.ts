// ============================================================================
// Noctis Protocol — CTO Governance: "Completed Successfully" Badge CLI
// ============================================================================
// PHP<->Node bridge, same convention as check-night-balance.ts and every
// other CLI in this directory: real logic lives in cto-badge.ts (tested
// directly, no simulator or network needed for the pure decision function);
// this script is a thin stdin/stdout wrapper so WordPress can shell out to
// it without a second, divergent implementation of the same logic.
//
// Input: single JSON object on stdin. Output: single JSON object on
// stdout, exit 0 on success (any real CtoCompletionStatus, including
// not_deployed, counts as success — the check itself completed), non-zero
// with {"error": "..."} on any failure the caller couldn't complete.
// ============================================================================

import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { checkCtoCompletionStatus } from '../cto-badge.js';

interface CheckCtoBadgeInput {
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
  let input: CheckCtoBadgeInput;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON on stdin.');
  }

  const required: Array<keyof CheckCtoBadgeInput> = ['indexerUri', 'indexerWsUri', 'contractAddressHex'];
  for (const key of required) {
    if (!input[key]) {
      throw new Error(`Missing required field: ${key}`);
    }
  }

  const publicDataProvider = indexerPublicDataProvider(input.indexerUri, input.indexerWsUri);
  const result = await checkCtoCompletionStatus(publicDataProvider, input.contractAddressHex);

  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
