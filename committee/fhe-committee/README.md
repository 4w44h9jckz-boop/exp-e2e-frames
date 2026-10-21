# fhe-committee

The FHE half of C1's committee: a TFHE decryption key shared among four members with Zama's
threshold-fhe, and a coprocessor that evaluates with the public server key. A rebuilt role:
Fhenix's CoFHE node is not public, so this follows its documentation over tfhe-rs and
threshold-fhe, unmodified, and tests the shape, not the product. See
[`../README.md`](../README.md).

**The key is dealt.** `setup` makes the whole TFHE key set and shares it, as threshold-fhe's own
library example does, so the dealer saw the whole decryption key once. `../README.md`, "Who
holds or sees what (C1)", lists every party, and "What a distributed TFHE keygen would cost"
prices the alternative from threshold-fhe's specification.

## The input format (fixed)

What the client encrypts, and what the wallet's request carries:

| | |
|---|---|
| Library | tfhe-rs `1.0.1`, the version threshold-fhe at the pinned commit builds |
| Keys | the committee's `CompactPublicKey` (`public/compact_public_key.bin`) and `CompactPkeCrs` (`public/crs.bin`), both in tfhe-rs's `safe_serialize` |
| Value | one `FheUint64`, alone in its list |
| Encoding | a `ProvenCompactCiphertextList`, built with `build_with_proof_packed(crs, metadata, ZkComputeLoad::Verify)`, written with `safe_serialize`: 18,786 bytes |
| Metadata | the bytes the proof is bound to; the coprocessor refuses the input under any other. The run that builds the request chooses them, for example the chain ID, the request contract and the sender |
| Proof | tfhe-zk-pok's compact public-key encryption proof over BLS12-446, the curve tfhe-rs 1.0.1 fixes (`zk::Curve`). The EVM has no precompile for that curve |

`fhe-committee encrypt` writes it from a value and metadata; `verify-input` checks the proof
alone; `evaluate` checks it, expands the list and computes (`--add k` or `--mul k`, wrapping at
2^64), and writes the result ciphertext with `safe_serialize`.

## Build

```bash
apt-get install protobuf-compiler   # protoc: threshold-fhe's build script needs it
cargo build --release
```

## Command line

```bash
fhe-committee setup --out fhe                                   # public/ and members/
fhe-committee encrypt --public fhe/public --value 41 --metadata 0x... --out input.bin
fhe-committee verify-input --public fhe/public --input input.bin --metadata 0x...
fhe-committee evaluate --public fhe/public --input input.bin --metadata 0x... --add 1 --out result.bin
fhe-committee decrypt --public fhe/public --members fhe/members --result result.bin --out decryption.json
```
