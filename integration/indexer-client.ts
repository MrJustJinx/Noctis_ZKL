// ============================================================================
// Noctis Protocol — Midnight Indexer Client (T65 check #2)
// ============================================================================
//
// Computes a Midnight address's real, current NIGHT balance by querying the
// public indexer directly — genuine third-party verification, not a wallet
// self-report. Uses @midnightntwrk/wallet-sdk-indexer-client's
// `UnshieldedTransactions` subscription (note the unhyphenated scope: this
// is the current `midnightntwrk/midnight-wallet` monorepo package; the older
// hyphenated `@midnight-ntwrk/wallet-sdk-indexer-client` traces to a legacy
// `artifacts` mirror and stops at 1.2.2).
//
// Why a subscription can compute a one-shot balance: the indexer's GraphQL
// schema has no Query field for this at all — only a Subscription. Checked
// the actual resolver source (indexer-api/src/infra/api/v4/subscription/
// unshielded.rs, `make_unshielded_transactions`): opening the subscription
// with `transactionId: 0` genuinely replays the address's full existing
// transaction history first ("streaming events for existing transactions")
// before switching to a live tail. `createdUtxos`/`spentUtxos` in each event
// are already scoped server-side to the queried address (confirmed via
// `get_unshielded_utxos_by_address_created_by_transaction`/`..._spent_...`)
// — no other party's UTXOs from the same transaction leak in.
//
// Termination: the merged `UnshieldedTransactionsProgress` stream reports
// `highestTransactionId` (the highest tx ID known at subscribe time) — but
// since it's merged with the backlog stream, not sequenced after it, a
// progress event can arrive before the backlog catches up to it. We keep
// consuming until we've actually SEEN a transaction whose own `id` reaches
// that watermark, not just until a progress event arrives. A watermark of 0
// with no transaction ever seen means the address has no history at all —
// terminate immediately with balance 0n. This whole pull-and-terminate
// pattern was verified against the real `effect` package with a mocked
// stream (4 cases: normal backlog, out-of-order progress arrival,
// zero-history address, clean stream end) before being used here.
// ============================================================================

import { Effect, Stream, Chunk, Option } from 'effect';
import { WsSubscriptionClient } from '@midnightntwrk/wallet-sdk-indexer-client/effect';
import { UnshieldedTransactions } from '@midnightntwrk/wallet-sdk-indexer-client';
import { nativeToken } from '@midnight-ntwrk/ledger-v8';

export interface NightBalanceResult {
  /** Atomic NIGHT units, matching the token's on-chain integer denomination. */
  balance: bigint;
  /** Number of transactions processed before reaching the known watermark. */
  transactionsProcessed: number;
}

/**
 * Query an address's current NIGHT (native token) balance from the public
 * Midnight indexer. `indexerWsUrl` is the indexer's GraphQL WebSocket
 * endpoint (per the indexer's own docs: `wss://<host>:<port>/api/v4/graphql/ws`).
 */
export async function getUnshieldedNightBalance(
  indexerWsUrl: string,
  address: string
): Promise<NightBalanceResult> {
  const nightTokenType = nativeToken().raw;

  const program = Effect.gen(function* () {
    const stream = UnshieldedTransactions.run({ address, transactionId: 0 });
    const pull = yield* Stream.toPull(stream);

    let balance = 0n;
    let highestKnownId: number | null = null;
    let sawAnyTransaction = false;
    let transactionsProcessed = 0;
    let caughtUp = false;

    while (!caughtUp) {
      const result = yield* Effect.either(pull);
      if (result._tag === 'Left') {
        // toPull's error channel is Option<E>: None means clean end of
        // stream (shouldn't happen against a real indexer, which streams
        // forever, but must not hang if it does); Some(e) is a real error.
        if (Option.isNone(result.left)) {
          break;
        }
        return yield* Effect.fail(result.left.value);
      }

      for (const event of Chunk.toReadonlyArray(result.right)) {
        const payload = event.unshieldedTransactions;

        if (payload.type === 'UnshieldedTransactionsProgress') {
          highestKnownId = payload.highestTransactionId;
          if (payload.highestTransactionId === 0 && !sawAnyTransaction) {
            caughtUp = true;
          }
          continue;
        }

        transactionsProcessed++;
        sawAnyTransaction = true;

        for (const utxo of payload.createdUtxos) {
          if (utxo.tokenType === nightTokenType) {
            balance += BigInt(utxo.value);
          }
        }
        for (const utxo of payload.spentUtxos) {
          if (utxo.tokenType === nightTokenType) {
            balance -= BigInt(utxo.value);
          }
        }

        const txId = payload.transaction.id;
        if (highestKnownId !== null && txId >= highestKnownId) {
          caughtUp = true;
          break;
        }
      }
    }

    return { balance, transactionsProcessed };
  });

  return Effect.runPromise(
    Effect.scoped(program.pipe(Effect.provide(WsSubscriptionClient.layer({ url: indexerWsUrl }))))
  );
}
