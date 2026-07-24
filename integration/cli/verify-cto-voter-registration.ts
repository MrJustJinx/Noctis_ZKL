// ============================================================================
// Noctis Protocol — CTO Governance: Voter Registration Verification CLI
// ============================================================================
// PHP<->Node bridge, same convention as every other CLI in this directory.
// A voter's browser submits {cardanoAddress, cip8SignatureHex, cip8KeyHex}
// to a REST endpoint (PHP, out of this repo's scope — WordPress work stays
// local); the endpoint shells out to this CLI to get a real, independently
// verified result before persisting the (cardanoAddress -> CTO voter
// pubkey) binding the balance-snapshot builder needs.
//
// Input: single JSON object on stdin. Output: single JSON object on
// stdout, exit 0 only on a genuinely verified registration — a failed
// verification is NOT modeled as a "successful check with a negative
// result" the way read-only CLIs in this directory do (e.g.
// check-cto-badge-status.ts's not_deployed), because there is no safe
// partial result here: either the signature is valid or the registration
// must be rejected outright.
// ============================================================================

import { verifyAndDeriveCtoVoterIdentity } from '../cto-voter-registration.js';

interface VerifyRegistrationInput {
  cardanoAddress: string;
  cip8SignatureHex: string;
  cip8KeyHex: string;
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
  let input: VerifyRegistrationInput;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON on stdin.');
  }

  const required: Array<keyof VerifyRegistrationInput> = ['cardanoAddress', 'cip8SignatureHex', 'cip8KeyHex'];
  for (const key of required) {
    if (!input[key]) {
      throw new Error(`Missing required field: ${key}`);
    }
  }

  const result = verifyAndDeriveCtoVoterIdentity({
    cardanoAddress: input.cardanoAddress,
    cip8SignatureHex: input.cip8SignatureHex,
    cip8KeyHex: input.cip8KeyHex,
  });

  process.stdout.write(JSON.stringify({ verified: true, ...result }));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ verified: false, error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
