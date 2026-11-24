# The local chain's simulated writes

A wallet that compares what a transaction will do with what its user approved needs the exact list
of writes the transaction makes, before it is signed. Neither public chain the experiments use gives
that for a frame transaction, as read on 2026-11-06:

- **The test network** (chain id 8141, `rpc1.privacy.ethrex.xyz`):
  - it serves no `debug_` namespace;
  - its `ethrex_simulateFrameTransaction` returns gas and validity per frame, and no writes.
- **The public Hegota devnet** (chain id 3,151,908, `rpc1.hegota.ethrex.xyz`):
  - `debug_traceTransaction` with `prestateTracer` in diff mode returns every balance, nonce and
    storage slot a mined frame transaction changed, but only after mining, and only within a short
    re-execution window;
  - there is no `debug_traceCall`;
  - its simulation also returns no writes.

So the local chain's ethrex gets a small patch: `ethrex_simulateFrameTransaction` returns the writes
its full execution already computes.

## The patch

`scripts/ethrex-writes.patch` changes one file, `crates/networking/rpc/ethrex.rs`, on top of
experiment 19's `ethrex-8288.patch`. `scripts/ethrex-writes.sh` applies it in `work/ethrex` and
rebuilds. ethrex is MIT or Apache-2.0, and `work/` is never committed.

**What it does.** After the simulation's full execution succeeds:
1. it reads the VM's state transitions;
2. it reads each changed account's prior state from a fresh view of the same head;
3. it returns them as a new field, `writes`.

Every other field is unchanged, so existing callers are unaffected. `writes` is `null` whenever the
full execution did not run, and otherwise a list sorted by address, one entry per changed account:

| Field | Meaning |
|---|---|
| `address` | the account |
| `removed` | the account was destroyed |
| `balance`, `nonce`, `codeHash` | `[before, after]`, present only when the value changed |
| `storage` | every slot whose value changed, each `{slot, before, after}`, sorted by slot |

A slot written and then restored within the transaction is not listed, because only before and
after are compared.

## The smoke test

`npx tsx scripts/simulated-writes-smoke.ts` puts two contracts in the local chain's genesis:
- an account whose `VERIFY` approves unconditionally, which uses no key of any kind;
- a writer, which sets `storage[word 0] = word 1`.

It then simulates `[VERIFY, SENDER set(1, 5), SENDER set(2, 2^256 - 1)]`. The second write stands
for one the signer was never told about.

Run on 2026-11-06, ethrex `64b8fc09d` with both patches, every check passed.

**The `writes` list named four accounts:**
- the writer's two slots, `1: 0 -> 5` and `2: 0 -> 2^256 - 1`;
- the payer's balance, falling by the fee;
- the fee recipient's balance, rising;
- one slot of the EIP-8250 nonce manager at `0x...8250`, the keyed nonce.

**After the transaction was sent and included,** every listed slot read back on chain equals its
simulated after-value.

**What a checker must allow for.** The fee's two balance changes and the nonce manager's slot are
writes every frame transaction makes. A rule that denies every write the signed intent does not list
has to name them, or exempt them by kind.

## What it is not

- **A local chain's answer only.** A wallet on a public chain would need the same field from that
  chain's client. The patch is offered as the shape of that request.
- **A simulation against the head.** A write list taken now can differ from the one at inclusion if
  state moves in between. Measuring how often that reverts an honest transaction is a separate
  question.
