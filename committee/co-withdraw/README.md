# co-withdraw

A three-party committee that proves the Tornado Cash withdrawal circuit with TACEO's co-snarks,
for the verifier the wallet's own proofs meet. Library and command line; see
[`../README.md`](../README.md) for how it is built and checked.

## The witness's share format (fixed)

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

## Command line

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

`member --recipient <hex>` proves for a recipient chosen after the witness was shared, as
experiment 14's committee binds its update to the openings it publishes. Every member passes the
same value. The recipient changes only two values of the witness, its public input (index 3,
counting the constant `1`) and its square (index 28,296), a private wire each member sets as a
trivial share of the public value (`set_recipient`); `tests::the_recipient_moves_one_private_wire`
checks that nothing else moves.

