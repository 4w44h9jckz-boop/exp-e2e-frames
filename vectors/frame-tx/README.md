# Frame transaction vectors

A public vector set for the bytes a wallet produces for an
[EIP-8141](https://eips.ethereum.org/EIPS/eip-8141) frame transaction. It uses
the [EIP-8250](https://eips.ethereum.org/EIPS/eip-8250) keyed nonce, as the
ethrex Hegota testnet encodes it. Any implementation can run against it. Three
already do, in [experiment 03](../../experiments/03-i2-one-frame-format/).

| File | Cases | Each case gives | The answer an implementation owes |
|---|---:|---|---|
| `transactions.json` | 200 | the transaction's fields, in the JSON shape the testnet serves for `eth_getTransactionByHash` | `raw` (`0x06 \vert\vert rlp(payload)`), `hash` (keccak-256 of `raw`), and `sigHash`, EIP-8141's `compute_sig_hash`: the payload with the signature bytes of every empty-`msg` entry elided |
| `reject.json` | 19 | raw bytes | a refusal |
| `execution-digest.json` | 10 | raw bytes | the domain separator, struct hash and digest $E$ of the execution-scope digest drafted in [exp-frames experiment 27](https://github.com/4w44h9jckz-boop/exp-frames/tree/85ee60d671c67a536c26265b8cba9fca78ff0360/experiments/27-execution-digest) |

## Where each expected value comes from

Every case names its source.

- **`chain`.** The 182 mined cases are every Hegota frame transaction in
  exp-frames' `test/fixtures/chain/` at `85ee60d`. Their expected `hash` is the
  one the chain gave the transaction. Their expected `sigHash` is marked
  `chain` when at least one empty-`msg` signature the chain accepted recovers
  its signer from it:
  - SECP256K1 by recovery;
  - P256 by verification with the key the signature carries.

  That holds for 159 of the 182. The rest carry no such signature, so their
  `sigHash` rests on the texts.
- **`texts`.** The 18 written cases cover shapes the chain has not mined:
  - integer and RLP length boundaries;
  - sixteen nonce keys;
  - signature elision with explicit and empty `msg`;
  - blobs;
  - a chain ID over 64 bits;
  - 64 frames.

  Their expected values come from the third implementation in experiment 03,
  written from the EIP texts alone.
- **`exp-frames experiment 27`.** The digest vectors as that experiment published
  them. It produced them with viem's `hashTypedData` and checked them by hand
  and inside ethrex's validation-prefix simulation.

The 6 fixtures from frames-devnet-0 use EIP-8141's own single-nonce envelope
and another client's JSON. They are left out.

`reject.json` lists encodings a decoder must refuse:
- EIP-8250's refusals: key count, order, a zero key alongside others,
  `nonce_seq` range, canonical integers;
- EIP-8141's structure: sender and target lengths, no frames, the shape of a
  frame, limits and fees;
- RLP's canonical form;
- trailing bytes and the type byte.

Each case says which rule it breaks.

## Regenerating

```bash
python3 vectors/frame-tx/tools/generate.py <exp-frames checkout> <commit>
```

It reads exp-frames at a commit of its `main` and is deterministic. The same
checkout gives the same files byte for byte. A mined case whose fields do not
encode to the chain's hash would be kept, with the chain's hash as the expected
value. None does at `85ee60d`. The generator also stops if the third
implementation accepts a reject case.
