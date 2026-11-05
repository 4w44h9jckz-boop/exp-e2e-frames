# How a client proof is laid out as a leanVM program

Written 2026-11-05 for every experiment that checks a client's proof as one leanSTARK dependency
of a frame transaction: the client proofs ported from Groth16, the post-quantum ticket, a TFHE
input proof, and any later one. It fixes what a program publishes, how a contract finds the proof's
claim, and how the chain receives the proof. It does not fix what any statement says.

Everything here is experiment 19's convention, which its versions 1, 2a, 2b and 5 ran on the local
chain (`experiments/19-x14-hash-based-stealth-addresses-under-8288/`). This document states the
convention once, so that programs written in other repositories fit the same chain.

## Two conditions every result states

- **leanVM has no zero knowledge** at the pinned commit. A proof hides nothing it was given, so
  every privacy result built on one is conditional on leanVM gaining zero knowledge.
- **[EIP-8288](https://eips.ethereum.org/EIPS/eip-8288) reserves `LEANSTARK_SCHEME`** (Draft, read
  at `ethereum/EIPs` master `46976b2`). A leanSTARK dependency is valid only on a chain that extends
  the EIP, which is the local chain's `extended` setting. On the test network it is modelled, as
  the last section says.

## The pins

| Piece | Pin |
|---|---|
| leanVM | `3cbac04`, through experiment 19's `prover/`, built with `-C target-cpu=native` |
| ethrex | `64b8fc09`, with experiment 19's `ethrex-8288.patch`, in the `extended` setting |
| the prover's commands | `x14-prover <program.py> <input.json> [repeat]` proves; `x14-prover verify <program.py> <public.json> <proof>` checks one proof |

A proof's time is comparable to experiment 19's only when the prover is built with
`-C target-cpu=native`.

## 1. The program and its key

- **One statement, one program file**, `<name>.py`, in the zkDSL leanVM compiles at its pin. The
  file's header comment states four things:
  - the statement;
  - each witness stream's name and its length in cells;
  - the formula for the published digest $D$, field by field, in order;
  - the line `# public_input: the two cells of D`.
- **The program's key** is `keccak256` of the file's bytes. leanVM's own key is the compiled
  bytecode, which the prover does not export. The source fixes it for the pinned compiler, so this
  family takes the source's hash as the key (`x14.ts`, `vkOf`). Changing one byte of the file,
  a comment included, makes a new program with a new key.
- **A contract holds the key it accepts**, fixed at deployment: appended to its code, as
  experiment 19's `Pool5` appends `VK5`, or as an immutable. It never reads the key from calldata.

## 2. Cells, the hash, and the digest

- **A cell** is 16 bytes, read little-endian as two 64-bit limbs. A 32-byte value is two cells: its
  bytes 0 to 15, then its bytes 16 to 31 (`lean.ts`, `cellsOf`).
- **The hash $H$** is leanVM's `keccak`: Keccak-256 over the cells' bytes, in order. Since a cell's
  bytes are the value's own bytes, $H(a, b)$ over two 32-byte values $a$ and $b$ is
  `keccak256(a || b)` on the EVM. `lean.ts`'s `cellKnownAnswer` checks this against leanVM's own
  test answer.
- **The program publishes exactly one digest $D$**, 32 bytes, as its whole public input. Its two
  cells go to positions 1 and `GEN` of the public memory:

  ```python
  p = GEN ** 0
  p[1] = d[0]
  p[GEN] = d[1]
  ```

- **$D$ folds in everything the contract checks.** The contract recomputes $D$ from its own
  storage and the transaction's calldata, with `keccak256` alone, and the proof's claim matches
  only if every field matches. Experiment 19's version 5, for one:

  $$D = H(H(\mathit{root}, \mathit{nf}), \mathit{binding})$$

- **$D$ binds the transaction.** Among its fields is a message $m$ that the contract rebuilds from
  what the transaction does: the chain id, the contract's own address, the nonce key or nullifier
  that makes the spend single-use, and every calldata field the contract acts on (a destination,
  an amount, a fee). A proof made for one transaction then fits no other. Each program's header
  says which fields $m$ holds.

## 3. One dependency per transaction

- **The triple** is 96 bytes: the scheme as a 32-byte word (`0x11` for leanSTARK), $D$, then the
  program's key.
- **One leanSTARK triple per transaction.** A statement that needs two proofs is written as one
  program that proves both, as the ticket's spend and the ticket share one dependency. A run that
  cannot be written this way is a finding, and it is recorded rather than split.
- **The dependency frame** is mode 4, with no target, flags 0, value 0, state limit 0, and an
  execution limit of 30,000 gas per leanSTARK triple (`x14.ts`, `depFrame`). EIP-8288 at master
  prices no leanSTARK triple, since the scheme is reserved. The 30,000 is this family's model, and
  every result states it.
- **It goes after the last `VERIFY` frame.** The patched ethrex pool recognizes a validation prefix
  only with the dependency frame there. A dependency between the sender's `VERIFY` and a
  paymaster's was refused as an unrecognized prefix (exp-frames experiment 49 on the local chain,
  run 2, in experiment 22's `results/49-local/`).

## 4. The contract's check

In `VERIFY`, the contract:
1. rebuilds $m$ and $D$ from its storage and the frame's calldata;
2. reads the dependency frame's data with `FRAMEDATALOAD`;
3. checks the scheme is `0x11`, the data hash is $D$, and the key is its own;
4. approves.

The contract never checks the proof. The block's validity covers every dependency, so a
transaction whose triple has no valid proof cannot be in a valid block. experiment 19's
`contracts/Stealth.yul` is the reference, in its function `triple`.

## 5. Handing the proof to the chain

- **The proof's bytes** are what `x14-prover` writes to the input's `proofOut`.
- **On the local chain** they go to the builder's witness directory before the transaction is sent,
  as `w-<k>.bin`. Here $k$ is `keccak256` of the scheme's byte, $D$ and the key, 65 bytes in that
  order, written as bare hex. `src/e2e/localchain.ts`'s `putStarkWitness` writes it. The builder
  copies it into the block's sidecar. It finds the program whose source hashes to the triple's key
  in the directory the chain was started with (`startLocalChain`'s `programs`). It then checks the
  proof with `x14-prover verify` against $D$, and a block with a dependency that does not verify is
  refused.
- **Every program a run's transactions name** must be in that one directory. A run that uses
  programs from more than one place copies them there before it starts the chain.
- **Through skandha's node path** (`frames_sendWrapper`, skandha `ef266b3`; `e9512aa` changes
  only `packages/node`), a wrapper's proof counts as checked only for a leanSPHINCS dependency.
  The node's surface (`packages/framepool/src/surface.ts`) checks those with the prover's
  `verify-sphincs`. Any other scheme's proof counts as unchecked, so a wrapper with a leanSTARK
  dependency is refused with `ErrWrapperProof`. Separately, its `eip-8288-master` profile reserves
  the scheme, as the EIP does. Its `eip-8288` profile defines the scheme, but with mode-3
  dependency frames, not the mode 4 this chain uses. This is read from skandha's source, not yet
  measured; the first run that sends a leanSTARK wrapper records it.

## 6. The test network: modelled

The test network has no EIP-8288. There, the triple goes in the contract's own `VERIFY` data,
after the statement's own fields, and no dependency frame is sent. The runner checks the proof off
chain with `x14-prover verify` against the same $D$ and key, before sending, and records the check.
Nothing on chain checks the proof, and the record says so.

## What would show this layout wrong

- A statement whose checked fields cannot all be folded into one 32-byte $D$ that a contract
  recomputes with `keccak256` alone.
- A run that needs two leanSTARK dependencies in one transaction.
- A program whose proving needs more than 16 GiB of memory.
- Two programs with different statements and one key.
