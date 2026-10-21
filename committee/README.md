# Committees

The committees that end-to-end runs keep, as Rust libraries, each with a command line a runner
calls. Every outside piece is pinned at a full commit, in `Cargo.toml` and in
[`pins.json`](pins.json), and `npm test` checks that the two agree.

| Crate | Committee | Used by |
|---|---|---|
| [`co-withdraw`](co-withdraw/) | three parties proving the privacy pool's withdrawal with TACEO's [co-snarks](https://github.com/TaceoLabs/co-snarks), for the verifier the wallet's own proofs meet | the TACEO run: a withdrawal proved by a committee, mined with the pool's verifier unchanged |
| [`fhe-committee`](fhe-committee/) and [`bls-committee`](bls-committee/) | one fixed committee of four with two keys: a threshold TFHE decryption key ([threshold-fhe](https://github.com/zama-ai/threshold-fhe)) with a coprocessor that evaluates, and a threshold BLS signing key from [Commonware](https://github.com/commonwarexyz/monorepo)'s DKG | the Fhenix run: an encrypted request evaluated, its result decrypted and signed by the committee, the signature checked in `VERIFY` |

```bash
cd committee
cargo test --release            # every crate's tests but fhe-committee's
cargo build --release           # target/release/<crate>
(cd fhe-committee && cargo test --release)   # its own workspace, about a minute
```

`fhe-committee` is a workspace of its own: threshold-fhe pins exact versions (tokio, tonic,
dashmap) that kohaku-rs's and Commonware's crates cannot share. Commonware comes from
[cmw-monorepo](https://github.com/4w44h9jckz-boop/cmw-monorepo)'s `committee/reshare-round`:
upstream `v2026.9.0` plus `dkg::feldman_desmedt::run`, which reports what each member sends.
It is patched in for every `commonware-*` crate, kohaku-rs's included.

Every member runs on one machine here, over loopback TCP. A time measured that way is a LAN time
and says so wherever it is written. What each member sends, in messages and bytes, is exact and
does not depend on the machine; it is reported first.

## `co-withdraw`

**What it proves.** The Tornado Cash withdrawal circuit, with the proving key
[kohaku-rs](https://github.com/4w44h9jckz-boop/kohaku-rs)'s wallet proves with
(`kohaku-tornadocash-circuit`), so the committee's proof is checked by the same verifier as the
wallet's: the patched Tornado verifier the frame-native pools call in their `VERIFY` frame
(`0x87a7C1f7...`, deployed by [exp-frames](https://github.com/4w44h9jckz-boop/exp-frames)
experiment 06).

**How.** The circuit is circom v1, and its key is in the websnark format. co-circom compiles
circom 2, so the committee does not extend the witness: the client does, from the circuit's
inputs, as it would before proving alone. It then splits the whole witness into three replicated
shares, which is co-circom's own `split-witness` path. The members run co-groth16's REP3 prover
(three parties, secure against one semi-honest member) over the wallet's key.

One piece is new, because neither of co-groth16's reductions fits a websnark key:
`WebsnarkReduction`, the witness map. A websnark key's quotient bases take the coefficients of
$H = (AB - C)/Z$. websnark computes them as the upper half of the coefficients of $AB$,
interpolated over the domain of twice the size, with the snarkjs root of unity from the
generator 7. The reduction does the same on shares:
- every step is linear, except two pointwise products;
- those products are co-groth16's own `local_mul_vec`, which needs no communication;
- it is checked against websnark's own prover in the clear, and three-party, in the crate's
  tests.

### The witness's share format (fixed)

This is what a client hands each member, and what kohaku-rs's wallet writes when it
secret-shares a withdrawal's witness. It is fixed: a change is a new format with a new name.

| | |
|---|---|
| Sharing | REP3, three members: member $i$ holds $(x_i, x_{i-1})$ of an additive sharing $x = x_0 + x_1 + x_2$ over BN254's scalar field |
| Witness | the circuit's whole witness as websnark extends it: index 0 the constant 1, then the six public inputs (root, nullifier hash, recipient, relayer, fee, refund), then every private signal: 28,300 values for this circuit, 28,293 of them private |
| What is shared | the private signals only. The constant and the six public inputs travel in the clear in every share |
| Encoding | co-snarks' `CompressedRep3SharedWitness<ark_bn254::Fr>` at the pinned commit, serialized with bincode 1, exactly as `co-circom split-witness` writes it. Its `witness` is `Replicated` (1,811,012 bytes per member for this circuit) or `SeededReplicated`, which a member expands locally |
| Refused | `Additive` and `SeededAdditive` shares: replicating them would add a round between the members |
| Files | `share-0.bin`, `share-1.bin`, `share-2.bin`, one per member, and `public.json` with the six public inputs as decimal strings |

A client that has the witness as a JSON array of decimal strings, the constant first, can run
`co-withdraw split --witness witness.json --out-dir shares`, or call `share_witness` from the
library. Either way, member $i$ receives only `share-i.bin`.

### Command line

```bash
co-withdraw demo-inputs --out inputs.json                 # a fresh note, the second of three leaves
co-withdraw split --inputs inputs.json --out-dir shares   # the client: witness, then three shares
co-withdraw split --witness witness.json --out-dir shares # or from a witness already extended
co-withdraw member --id 0 --share shares/share-0.bin \
  --peers 127.0.0.1:10000,127.0.0.1:10001,127.0.0.1:10002 --out member-0.json
co-withdraw local --shares shares --out members.json      # all three members, loopback TCP
co-withdraw verify --proof members.json                   # against the pool's verifying key
co-withdraw vk --out vk.json                              # that key, as JSON
```

`inputs.json` is `kohaku-tornadocash-circuit`'s `CircuitInputs`. A member writes its proof
twice: as websnark writes one (`pi_a`, `pi_b`, `pi_c`), and as the eight 32-byte words the
pool's verifier takes. It also writes the public inputs, whether the proof verifies, and, for
each peer, the messages and bytes it sent and received.

### The recorded check

`npx tsx scripts/committee-c2.ts [label]` runs the command line from a committed tree. It then
asks the chain's verifier, by `eth_call`, about the proof as made and about the proof with one
public input changed. It writes `test/fixtures/committee/c2-<label>.json`. `npm test` checks
that record offline:
- each proof is paired again with noble's BN254, against the key whose every coordinate is in
  the recorded verifier code;
- the members agree;
- every byte one member sent, its peer received.

## `fhe-committee` and `bls-committee`: C1

One committee of four members, fixed for a run, holding two keys.

| Key | Made by | Held | Used for |
|---|---|---|---|
| TFHE decryption key (`BC_PARAMS_SAM_SNS`) | threshold-fhe's `gen_key_set`, shared with its `keygen_all_party_shares`: **a dealer** | four shares, any one of which reveals nothing (`n = 4`, `t = 1`) | noise-flooding distributed decryption of a result |
| BLS12-381 signing key, `MinSig` | Commonware's Joint-Feldman DKG, every member a dealer and a player: **no dealer** | four shares, any three of which sign | signing the decrypted result for a `VERIFY` frame |

**The FHE key is dealt.** threshold-fhe has a distributed key generation, but its secure
preprocessing for these parameters is far beyond one machine's run; its own library example
deals the key and shares it, and so does this. What the chain and the nodes see is the same
either way: a compact public key, a result ciphertext, a signature under the BLS key. Who held
the whole TFHE key, once, is the difference, and the record says so.

The coprocessor holds only public material: the server key it evaluates with. Every member and
the coprocessor read the same public key set, 1.2 GB, almost all of it the switch-and-squash key
that noise-flooding decryption needs.

### The input format (fixed)

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

### The signed result (fixed)

`bls-committee` signs, under Commonware's `ops::sign_message::<MinSig>` with namespace
`FRAME_FHE_RESULT_V1`:

```text
message = chain_id (32) || request (32) || handle (32) || value (32)          128 bytes
```

- `request`: 32 bytes the result transaction names its request by;
- `handle`: keccak256 of the result ciphertext's bytes, as the coprocessor wrote them;
- `value`: the decrypted value, big-endian.

The point signed is `hash_to_curve(len(namespace) || namespace || message)` in G1, RFC 9380's
`BLS12381G1_XMD:SHA-256_SSWU_RO_` suite under the DST `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_POP_`,
the same as a blind ticket's. So the ticket paymaster's check, with its namespace and message
changed, checks a result: `e(sigma, -g2) e(H(m), PK) = 1` on EIP-2537. The signature is 128 bytes
and the key 256, in EIP-2537's encodings.

`sign` refuses fewer signers than the quorum. `sign-below` writes what two of four can make, the
interpolation of their two partials at zero, so a run can show it refused.

### Command line

```bash
fhe-committee setup --out fhe                                   # public/ and members/
fhe-committee encrypt --public fhe/public --value 41 --metadata 0x... --out input.bin
fhe-committee verify-input --public fhe/public --input input.bin --metadata 0x...
fhe-committee evaluate --public fhe/public --input input.bin --metadata 0x... --add 1 --out result.bin
fhe-committee decrypt --public fhe/public --members fhe/members --result result.bin --out decryption.json
bls-committee dkg --members 4 --out bls                         # public.json, sharing.bin, member-<i>.share
bls-committee sign --dir bls --signers 0,1,2 --chain-id 8141 --request 0x... --ciphertext result.bin --value 42 --out signed.json
bls-committee sign-below --dir bls --signers 0,1 ... --out below.json
bls-committee verify --dir bls --signed signed.json
```

`decryption.json` holds the value and, per member, the messages and bytes sent and received and
threshold-fhe's round count. `public.json` holds the group key, each member's partial key, and
what each member sent during the DKG.

### The recorded check

`npx tsx scripts/committee-c1.ts [label]` runs all of it from a committed tree, then asks the
chain's EIP-2537 pairing precompile (`0x0f`), by `eth_call`, about the quorum's signature and the
two members' interpolation. It writes `test/fixtures/committee/c1-<label>.json`. `npm test`
checks it offline: the value, the message's layout, every signature and partial paired again with
noble's BLS12-381, and the traffic.
