# Committees

The committees that end-to-end runs keep, as Rust libraries, each with a command line a runner
calls. Every outside piece is pinned at a full commit, in `Cargo.toml` and in
[`pins.json`](pins.json), and `npm test` checks that the two agree.

| Crate | Committee | Used by |
|---|---|---|
| [`co-withdraw`](co-withdraw/) | three parties proving the privacy pool's withdrawal with TACEO's [co-snarks](https://github.com/TaceoLabs/co-snarks), for the verifier the wallet's own proofs meet | the TACEO run: a withdrawal proved by a committee, mined with the pool's verifier unchanged |

```bash
cd committee
cargo test --release            # every crate's tests
cargo build --release           # target/release/<crate>
```

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
