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

Nothing here crosses a real network: the members of a committee are threads or processes on the
same machine, talking over loopback TCP or in memory. Any wall-clock figure from such a run is
therefore a best case, the speed of a local network at most, and each record and README names the
network its times came from. Messages and bytes per member do not depend on the machine, so they
come first.

These are rebuilt roles, not the products: Fhenix's CoFHE node and TACEO's Merces are not public,
so the coprocessor and the committees follow the projects' documentation and use their published
libraries unmodified (co-snarks, tfhe-rs, threshold-fhe), each pinned with its licence in
`pins.json`. A run tests the shape of the system, not the system.

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

Written in [`co-withdraw/README.md`](co-withdraw/README.md), "The witness's share format
(fixed)": REP3 shares of the whole websnark witness over BN254's scalar field, in co-circom's
`split-witness` encoding.

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

**The claim, as amended before this run.** A request's encrypted input is evaluated by a
coprocessor, and its result is decrypted and signed by a threshold of the committee, so a
`VERIFY` frame checks the result by one BLS signature under the committee's key. Its budget is
the testnet nodes' 500,000 gas for a `VERIFY` frame: no BLS check fits EIP-8141's 100,000, since
the pairing alone costs 102,900 under EIP-2537's prices (derived). What would show it wrong:
- a result signed by fewer than the quorum verifies;
- a result signature verifies for a request it was not made for;
- two different results for one request each carry a valid signature.

The committee keeps `q > (n + t) / 2` (`n = 4`, `q = 3`, `t = 1`) and a lock per request in each
member. The below-quorum test gives `t` members, and then `q - 1`, their shares and the DKG's
public output, and lets them try.

| Key | Made by | Held | Used for |
|---|---|---|---|
| TFHE decryption key (`BC_PARAMS_SAM_SNS`) | threshold-fhe's `gen_key_set`, shared with its `keygen_all_party_shares`: **a dealer** | four shares, any one of which reveals nothing (`n = 4`, `t = 1`) | noise-flooding distributed decryption of a result |
| BLS12-381 signing key, `MinSig` | Commonware's Joint-Feldman DKG, every member a dealer and a player: **no dealer** | four shares, any three of which sign | signing the decrypted result for a `VERIFY` frame |

**The FHE key is dealt, and the dealer saw the whole key once.** threshold-fhe has a distributed
key generation, but its secure preprocessing for these parameters is far beyond one machine's
run (priced below); its own library example deals the key and shares it, and so does this. The
owner accepted the dealt key for the Fhenix run (2026-10-21). What the chain and the nodes see is the same
either way: a compact public key, a result ciphertext, a signature under the BLS key. Who held
the whole TFHE key, once, is the difference, and the record says so.

The coprocessor holds only public material: the server key it evaluates with. Every member and
the coprocessor read the same public key set, 1.2 GB, almost all of it the switch-and-squash key
that noise-flooding decryption needs.

### Who holds or sees what (C1)

| Party | Holds or sees |
|---|---|
| the dealer, `fhe-committee setup` | **the whole TFHE decryption key, once**, while it makes and shares it; then it writes the four shares and keeps nothing. X5 runs with this dealt key at the owner's word (2026-10-21) |
| each FHE member | its share of the TFHE key; during a decryption, the other members' messages, and the decrypted value |
| the coprocessor | public material only: the server key, the compact public key, the CRS; inputs and results as ciphertexts |
| the BLS DKG | no dealer: no party ever holds the BLS key |
| each BLS member | its share of the BLS key, the public sharing, and its locks |
| whoever combines the partials | the quorum's partial signatures; only the combined signature is published |
| the chain and the nodes | the request's ciphertext and proof, the result's handle and value, the signature, the BLS key |

### What a distributed TFHE keygen would cost (derived and quoted, not run)

threshold-fhe has a robust distributed keygen; this run does not use it. From its own
specification (`docs/CryptographicDocumentation.pdf` at the pinned commit) and code:
- **Online: five rounds** (quoted, section 9.6.5): two to make the shared random bits in one
  batch, one to open the seed, one to open the key material, one for the multiplications.
- **Offline: hundreds of millions of multiplication triples** (quoted, Table 17): 430,102,352 to
  741,538,796 for the parameter sets it tabulates with its flag `fg` set, which adds a second
  bootstrapping key (a switch-and-squash key, which noise-flooding decryption needs), and
  19,577,758 to 53,432,222 without it. This run's
  `BC_PARAMS_SAM_SNS` is not one of the tabulated sets; it has a switch-and-squash key, so the
  first range is the relevant one.
- **Bytes** (derived, an order of magnitude only): the small-committee triple generation
  (section 9.4.2) costs, on the happy path, one synchronous broadcast of one ring element per
  party, `O(log q * d * n^3)` in all. With `log q = 128`, `d = 4` (the extension degree this
  build uses), a 64-byte element, and a broadcast of about `2 n^2` messages, four members send
  about `2 * 4^3 = 128` messages, 8 KiB, per triple, 2 KiB a member. At 430 million triples that
  is roughly 0.9 TB sent by each member, before the five online rounds. Table 18 shows how the
  implementation stores less (bits and distribution samples instead of triples), but the triples
  are still generated.

### The input format (fixed)

Written in [`fhe-committee/README.md`](fhe-committee/README.md), "The input format (fixed)": one
`FheUint64` in a tfhe-rs 1.0.1 `ProvenCompactCiphertextList`, proven under the committee's CRS
and bound to the request's metadata.

### The signed result (fixed)

Written in [`bls-committee/README.md`](bls-committee/README.md), "The signed result (fixed)":
`chain_id || request || handle || value` under namespace `FRAME_FHE_RESULT_V1`, `MinSig`, hashed
as a blind ticket is, with one lock per request in every member.

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

`npx tsx scripts/committee-c1.ts [label]` runs all of it from a committed tree: the quorum's
signature, a second result for the same request (every member asked, then with member 0
corrupted), and `t` and then `q - 1` members' forging attempts. It then asks the chain's EIP-2537
pairing precompile (`0x0f`), by `eth_call`, about the quorum's signature, the same signature for
another request, the two members' interpolation and every forging attempt. It writes `test/fixtures/committee/c1-<label>.json`. `npm test`
checks it offline: the value, the message's layout, every signature and partial paired again with
noble's BLS12-381, and the traffic.
