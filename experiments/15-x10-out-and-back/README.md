# Experiment 15 (X10): a note out to a public contract and back, in one transaction

**Status: pre-registered.** This README states the question, the design, the predictions and
what would show them wrong, and is pushed before any circuit, contract or transaction.

A private note sometimes has to leave its owner for a computation on shared public state, and
come back as a new note. The example here is a swap of a note of ether against an automated
market maker (AMM) on L1, which pays out a note of a test token. The question is how to make that
round trip cheap without anyone holding the state in between, and what each saving costs.

The registry's interface follows a draft standard for private owned state: a private transaction
is `processPrivateTransaction`, a note leaves through an export that calls the destination's
`onPrivateExport(bytes)`, and value comes back through an import that a public contract
registers with `registerImportReceipt(address,bytes32,bytes32)`. The mechanics are this
repository's and exp-frames experiments 32 and 33's: the registry is the sender of its own frame
transaction, its `VERIFY` frame checks the proof, the nullifiers are its EIP-8250 nonce keys, and
roots are read through EIP-8272. Where the two differ, the difference is listed below and in the
results.

## Four configurations, one AMM

| | Transactions per swap | Proofs | Where new notes go | The swap's output note |
|---|---|---|---|---|
| **R0**, the draft's bridge | 2: spend and export; then import | 2: the spend's, the import's | inserted into the on-chain tree | the AMM registers a receipt; a second private transaction claims it |
| **R1**, one transaction (A + B) | 1 | 1 | inserted into the on-chain tree | the AMM calls back and completes a partial note in the same transaction |
| **R2**, appended (A + B + C) | 1, and a share of a batch | 1, and a share of a batch proof | appended to an accumulator; a batch proof advances the root every 8 leaves | as R1 |
| **R3**, a round (A + B + C + D) | 1 for 4 owners, and a share of a batch | 1 for 4 owners, made by a three-member co-SNARK committee | as R2 | as R1, one call-back for the 4 |

**A, one transaction.** The spend, the export, the swap and the new note are one frame
transaction. A separate lock transaction is needed only when a job outlives a transaction, and a
swap against public state does not.

**B, the call-back.** The proof binds a partial note `(tagOut, innerOut)`, whose value nobody knows
when the owner proves. The AMM swaps, pays the token to the registry, and calls back
`completeImport(partial, value)`. The registry checks that the caller is the export's
destination, inside that export, once, and that its own token balance rose by at least `value`.
It then inserts or appends the leaf $H(\mathrm{tagOut}, \mathrm{innerOut}, \mathrm{value})$.

**The fallback.** In a frame transaction a nonce key is used once `VERIFY` approves, whatever a
later frame does (experiment 14's early redemption). So a failed swap cannot undo the spend. The
proof also binds a refund note for the input, and the registry runs the export inside a call to
itself that reverts unless the call-back completed. If it reverts, the AMM's side unwinds and the
registry adds the refund note instead.

**C, append, then batch.** A new leaf costs one accumulator update,
$\mathrm{acc} \leftarrow \mathrm{keccak256}(\mathrm{acc} \parallel \mathrm{leaf})$, and an event. Every 8 leaves,
anyone may send a batch: the registry, as sender and payer, checks a proof that the new root is
the old root with those 8 leaves in the next aligned subtree, and that the leaves hash to the
accumulator's checkpoint. A leaf is spendable once its batch is in. Nothing in the contract hashes
the tree.

**D, a round.** Four owners each hold one note of the same denomination. A committee of three,
holding the four owners' witnesses as replicated secret shares (TACEO's co-circom, as experiment 13
ran it), proves one statement for all four: four notes in the tree, four nullifiers, four refund
notes. One transaction spends the four, makes one AMM call, and the call-back completes four
partial notes with equal shares of the output. No member sees a witness alone.

## The pieces

- **Circuits** (circom, Groth16, MiMC as Tornado Cash's tree):
  - `kernel`: one spend, with a change note, a refund note and a binding;
  - `import`: R0's claim of a receipt;
  - `batch8`: eight leaves into the next aligned subtree;
  - `round4`: four spends of one denomination.
- **Contracts**:
  - `Registry.yul`: one contract, deployed twice, inserting (R0, R1) or appending (R2, R3);
  - exp-frames experiment 32's `Groth16Verifier.yul`, unchanged, once per circuit;
  - `TestToken`;
  - `Amm`: constant product, ether and the token, 0.3 percent fee.
- **The tree's hash** is experiment 06's deployed MiMC hasher, so leaves and roots match exp-frames
  experiments 06, 32 and 33.
- **Transactions** go through two skandha nodes, as in experiments 01 to 14, unless the nodes refuse
  a layout the testnet admits; any such case is recorded, and the transaction is then sent to the
  testnet directly.
- **Every step is simulated** on the testnet before it is sent. No local ethrex rehearsal: the
  binary is not available here, and the testnet's simulation is the check.

## What is predicted, written before the run

1. **R1 against R0:** one transaction and one proof fewer per swap, and less total gas. The swap
   completes in the transaction that spends the note.
2. **The call-back cannot be abused:**
   - a completion from any caller but the export's destination is refused;
   - so is one outside the export call;
   - so is a second completion of one partial note;
   - so is a value the registry's token balance does not cover.
3. **A failed swap returns the input.** With a minimum output the pool cannot meet, the
   transaction is mined, the nullifier is used, no token moves, and a refund note for the input is
   added. That note is later spent by its owner.
4. **R2 against R1:** the per-note cost is one accumulator update and an eighth of a batch, far below
   one on-chain insertion. The price is latency: a note is spendable only after its batch.
5. **A batch cannot advance the root over leaves the registry did not take in.** A batch whose leaves
   do not hash to the checkpoint is refused before inclusion. So is one whose proof is for another
   root.
6. **R3 against R2:** per owner, less gas than four separate R2 swaps, and one proof for four.
7. **A round with one owner's note already spent is refused** at the node, by the nonce key.
8. **Every output note is a note.** A note completed by a call-back, and a refund note, are each
   spent afterwards with an ordinary proof.

## What would show it wrong

- R1 costs as much total gas as R0, or more.
- Any abuse in item 2 is admitted.
- A failed swap is mined without a refund note, or with token or ether moved.
- R2's per-note cost is not below R1's.
- A batch over leaves the registry did not append is admitted.
- R3's per-owner gas is not below R2's, or a round with a spent note is admitted.
- A completed or refund note cannot be spent.

## What is recorded with no prediction

- Gas by frame (execution and state) for every transaction.
- Calldata bytes.
- Blocks from a swap until its output note is spendable.
- Proving time per circuit, on one machine. For the committee: messages and bytes per member, over
  loopback, which is a LAN figure at best.
- What becomes public in each configuration:
  - the asset pair and the AMM;
  - the input amount and the output amount;
  - the partial note's `innerOut`;
  - in R3, that four owners swapped together, and their equal shares.

## Deviations from the draft standard, stated in advance

| Draft | Here | Why |
|---|---|---|
| the proof checked in execution | the proof checked in `VERIFY`, so a bad proof never enters a block | frame transactions; nobody pays for an invalid proof |
| an indexed nullifier tree in storage | the nullifiers are the registry's EIP-8250 nonce keys | the mempool refuses a double spend before inclusion |
| a 256-block root buffer in storage | EIP-8272's predeploy | already on the testnet; exp-frames 32 and 33 |
| Poseidon2 through a precompile | MiMC through experiment 06's hasher, and not at all on chain in R2 and R3 | no such precompile on the testnet |
| imports processed before exports | a completion inside the export's call-back (R1 to R3); the draft's order kept for R0 | the draft's order cannot claim a receipt in the transaction that registered it |
| STARK proofs, recursive application circuits | Groth16 and fixed circuits | the tooling of exp-frames 32 and 33 |
| encrypted logs for note discovery | not modelled | outside this question |
