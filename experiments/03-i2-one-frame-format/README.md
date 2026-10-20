# Experiment 03: one frame format across wallets

**The claim.** Two wallets that were built apart produce the same bytes for the
same frame transaction:
- [exp-frames](https://github.com/4w44h9jckz-boop/exp-frames)' TypeScript
  library;
- [kohaku-rs](https://github.com/4w44h9jckz-boop/kohaku-rs)' `kohaku-frame-kit`,
  in Rust.

They agree on the envelope and its hash, on the canonical signature hash, and on
the execution digest. A third implementation, written from the EIP texts alone,
agrees with both. So the format is a standard that a new wallet can be checked
against, not a habit two codebases share.

**What would show it wrong.** Written on 2026-10-20, before any vector was
generated or any implementation was run against one:
- on some vector, the two wallets give different bytes, hash, signature hash or
  digest;
- on some vector, one wallet accepts an encoding that the other refuses;
- a mined transaction's fields do not encode, in either wallet, to the hash the
  chain gave it;
- the third implementation disagrees on a vector, and the EIP texts do not
  settle which side is right. That would show the texts leave the format open,
  which is a result too.

## The vector set

The vectors live in `vectors/frame-tx/`, apart from any implementation. Each
expected value names where it comes from:

| File | What it fixes | Where the expected value comes from |
|---|---|---|
| `transactions.json` | a transaction's fields; its raw bytes `0x06 \vert\vert rlp(...)`; its hash; and its canonical signature hash, with the signature bytes of every empty-`msg` entry elided | **mined cases:** the chain. The hash is the one the chain gave. The signature hash is the one from which a signature the chain accepted recovers its signer. **Written cases:** the EIP texts, for shapes the chain has not mined |
| `execution-digest.json` | the execution-scope digest $E$ of exp-frames' draft ERC (experiment 27) | experiment 27's vectors, which ethrex's validation-prefix simulation also ran |
| `reject.json` | encodings a wallet must refuse | the EIP texts and RLP's canonical form |

The set's own README, `vectors/frame-tx/README.md`, gives the counts and how it
is generated.

## Implementations

| Implementation | Pinned at | Run by |
|---|---|---|
| exp-frames' `src/frametx` (TypeScript, viem) | `pins.json` | `run.ts`, which imports it from a checkout |
| kohaku-rs's `kohaku-frame-kit` (Rust, alloy) | `pins.json` | `rust/`, a small runner crate built against a checkout |
| a third, from the EIP texts (Python, standard library only, its own keccak) | this directory | `py/frametx.py` |

Nothing here edits either wallet. A disagreement is reported to the wallet that
is wrong, or to the EIP when the texts leave it open.

## Run

```bash
npm install
npx tsx experiments/03-i2-one-frame-format/run.ts
npm test
```

Steps:
1. `run.ts` checks out both wallets at their pins.
2. It builds the Rust runner (`cargo`).
3. It asks each implementation for its answers.
4. It records every answer and every disagreement in `results.json`.

`npm test` checks offline that:
- the record was run against the vector set as committed;
- it lists exactly the answers that differ;
- every raw transaction in the set hashes to its hash.

The run needs no network beyond the two checkouts, and no key.

## Results

Run once, on 2026-10-20, with:
- exp-frames at `85ee60d`;
- kohaku-rs at `5785883`;
- the vector set as committed with this README.

| | Cases | exp-frames (TypeScript) | kohaku-frame-kit (Rust) | from the texts (Python) |
|---|---:|---|---|---|
| mined transactions: raw, hash, signature hash | 182 | all agree | all agree | all agree |
| written transactions: raw, hash, signature hash | 18 | all agree | 17 agree; refuses one | all agree |
| execution digest | 10 | all agree | all agree | all agree |
| encodings a decoder must refuse | 19 | **accepts 10** | **accepts 6** | refuses all 19 |

The encodings each one accepts:

| Case | Rule it breaks | exp-frames | kohaku-rs |
|---|---|---|---|
| no nonce keys | EIP-8250: `len(nonce_keys) < 1` | **accepts** | **accepts** |
| seventeen nonce keys | EIP-8250: more than `MAX_NONCE_KEYS` | **accepts** | **accepts** |
| nonce keys out of order | EIP-8250: not strictly increasing | **accepts** | **accepts** |
| a repeated nonce key | EIP-8250: not strictly increasing | **accepts** | **accepts** |
| key 0 with another key | EIP-8250: a zero key and `nonce_keys != [0]` | **accepts** | **accepts** |
| no frames | EIP-8141: `len(tx.frames) > 0` | **accepts** | **accepts** |
| `nonce_seq` of $2^{64}$ | EIP-8250: `nonce_seq >= 2**64` | **accepts** | refuses |
| limits of three fields | `limits = [execution, state]` | **accepts** | refuses |
| a single byte given a length prefix | RLP's canonical form | **accepts** | refuses |
| a long length for a short list | RLP's canonical form | **accepts** | refuses |

Both refuse the other nine.

## Observations

1. **On encoding, the claim holds.** For every transaction both wallets take,
   they produce the same bytes, the same hash and the same signature hash as
   each other and as the chain:
   - the 182 mined transactions;
   - 17 of the 18 written shapes, with boundaries at 55 and 56 bytes, sixteen
     nonce keys and signature elision.

   The text-only implementation does too, so the encoding is recoverable from
   the EIPs alone. The execution digest agrees in all three.
2. **On decoding, it is shown wrong.** It fails the line written before the
   run: "one wallet accepts an encoding that the other refuses". exp-frames
   accepts four encodings that kohaku-rs refuses:
   - a `nonce_seq` past 64 bits;
   - limits of three fields, whose third it ignores;
   - two non-canonical RLP forms, which viem's `fromRlp` reads leniently.

   Both wallets accept six that EIP-8250 and EIP-8141 say a decoder must
   refuse: empty, oversized, unordered, repeated or mixed nonce-key sets, and
   no frames. Both document their parser as "structural only", so these are
   omissions their authors chose. But two wallets that parse each other's
   output differently do not yet share a format. A wallet that reads a
   transaction to show it to a user should refuse what no client would
   accept.
3. **kohaku-rs takes a chain ID only up to 64 bits.** EIP-8141 allows any
   `chain_id < 2**256`, and it holds it as a `u64`. No chain in use needs
   more, but a vector set has to say what the type allows.
4. **The execution digest's check is two implementations deep, not three.**
   The digest vectors were produced by viem in exp-frames, so exp-frames'
   agreement with them is by construction. kohaku-rs's alloy encoder and the
   text-only implementation are the independent checks, and both agree.
5. **What the set does not cover yet:**
   - EIP-8141's own single-nonce envelope, which only frames-devnet-0 used and
     kohaku-rs does not encode;
   - signature validity itself: recovery, low-s and P256's signer address.
     The set pins the hash a signature covers, not whether one is valid;
   - a third wallet, as distinct from a third implementation.
