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
| `envelope.json` | a transaction's fields, its raw bytes `0x06 \vert\vert rlp(...)`, and its hash | **mined cases:** the chain. The fields are as the node returned them, and the hash is the one the chain gave the transaction. **Written cases:** the EIP texts, for shapes the chain has not mined |
| `sig-hash.json` | the canonical signature hash, with the signature bytes of every empty-`msg` entry elided | **mined cases with a SECP256K1 signature over it:** the chain, because the chain accepted a signature that recovers its signer from this hash. **The rest:** the EIP text |
| `execution-digest.json` | the execution-scope digest $E$ of exp-frames' draft ERC (experiment 27) | experiment 27's vectors, which ethrex's validation-prefix simulation also ran |
| `reject.json` | encodings a wallet must refuse | the EIP texts and RLP's canonical form |

## Implementations

| Implementation | Pinned at | Run by |
|---|---|---|
| exp-frames' `src/frametx` (TypeScript, viem) | `pins.json` | `run.ts`, which imports it from a checkout |
| kohaku-rs's `kohaku-frame-kit` (Rust, alloy) | `pins.json` | `rust/`, a small runner crate built against a checkout |
| a third, from the EIP texts (Python, standard library only, its own keccak) | this directory | `py/frametx.py` |

Nothing here edits either wallet. A disagreement is reported to the wallet that
is wrong, or to the EIP when the texts leave it open.
