# Experiment 15 (X10): a note out to a public contract and back, in one transaction

**Status: run.** The question, the design, the predictions and what would show them wrong were
pushed at `9d43131`, before any circuit, contract or transaction; the circuits, contracts and
runner followed at `5318013`. Run 1's results are below ("Results, run 1"): nothing in it shows a
prediction wrong, and one half of prediction 5 was not sent.

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

## Results, run 1 (`results/1-first-run.json`)

Run on 2026-10-29 on the test network (ethrex `64b8fc09`, as the record's `client` says), at this
repository's `269fba1`, with skandha `ede942f` and co-snarks `436f63f`, as deployment `d5`. The
registries were `0x163D21cD...` (inserting, R0 and R1) and `0x4DC7ae97...` (appending, R2 and
R3), the AMM `0x359DBDEf...`. The set-up went to the chain directly. Every step after it went to
node A, which gossiped it to node B, which alone handed it to the chain: both nodes logged every
mined step, and B agreed with A each time (`handoff`, `agrees: true`). The runner searched the
record for every secret before writing it. The 17 mined transactions are kept in
`test/fixtures/x10/1-first-run.json`, and `test/x10.test.ts` rebuilds each and verifies its proof
offline.

| Step | Prediction | Outcome | Block | Gas |
|---|---|---|---|---|
| R0a: spend and export; the AMM registers a receipt | 1 | mined, a receipt for 47,482,521,474,531,556 | 602,165 | 626,206 |
| R0b: claim the receipt with a second proof | 1 | mined, one block later | 602,166 | 1,412,863 |
| R1: spend, export, swap and the new note in one transaction | 1 | mined, completed at 43,171,854,872,599,579 | 602,169 | 1,555,433 |
| F3: a minimum ten times the quote | 3 | mined; the refund note added, nothing completed | 602,172 | 1,463,599 |
| F2: a destination that claims without paying | 2 | mined; refund, no completion | 602,175 | 1,462,225 |
| F2: a destination that completes twice | 2 | mined; refund, no completion | 602,178 | 2,474,499 |
| F2: a destination that pays and has another contract call back | 2 | mined; refund, no completion | 602,181 | 1,477,627 |
| F2: a destination that keeps the ether and never calls back | 2 | mined; refund, no completion | 602,184 | 1,450,043 |
| F2: a completion with no export in flight (`eth_call`) | 2 | reverted | | |
| P8a: R0's claimed note paid out | 8 | mined, the receipt's value paid | 602,187 | 489,780 |
| P8b: R1's completed note paid out | 8 | mined, the completion's value paid | 602,190 | 478,188 |
| P8c: F3's refund note paid out | 8 | mined, 999,990,000,000,000 wei paid | 602,193 | 557,457 |
| B0: the first batch, eight deposits | | mined | 602,195 | 623,638 |
| R2: R1 on the appending registry | 4 | mined, completed at 39,422,955,259,903,969 | 602,198 | 597,193 |
| R3: a round of four owners, one committee proof | 6 | mined, four completions of 32,136,950,371,255,423 | 602,204 | 1,038,424 |
| F7: a round with R2's spent note in it | 7 | refused at node A: `ErrNonceTooLow` | | |
| F5: a batch with leaves 8 and 9 swapped | 5 | refused at node A: `ErrFramePrefixReverted` | | |
| B1: the second batch, with R2's and the round's notes | 4 | mined | 602,210 | 525,754 |
| P8d: R2's completed note paid out | 8 | mined, the completion's value paid | 602,213 | 489,802 |
| P8e: one round note paid out | 8 | mined, one share paid | 602,216 | 489,766 |

Values are in the token's or ether's smallest unit. Each spend put in a note of $10^{15}$ wei less
the registry's fee of $10^{10}$; the round put in four notes less one fee.

**Against each prediction:**
1. **R1 against R0: held.** R1 used 1,555,433 gas in one transaction with one proof. R0 used
   626,206 and then 1,412,863, 2,039,069 in all, with two proofs: R1 is about 24 percent less. R0's
   output waited in a receipt until the owner's second transaction, one block later here.
2. **The call-back cannot be abused: held.** Each of the four destinations' transactions was mined
   with the refund note and no completion. The registry's token balance did not move, and no
   destination kept any ether (`abuse` in the record). A completion with no export in flight
   reverted. The destination that completed twice is the instructive one: its first completion
   passed, its second reverted, and that reverted its whole call, the first completion with it.
3. **A failed swap returns the input: held.** F3's receipt logs the spend, the refund note's
   append and the refund, and no token transfer and no ether transfer (EIP-7708 would log one). Its
   nonce key is used. P8c spent the refund note to a fresh account.
4. **R2 against R1: held.** The swap's own transaction fell from 1,555,433 to 597,193 gas: its
   `SENDER` frame from 1,096,924 to 138,724 execution gas, the difference being the on-chain
   insertion. With an eighth of a batch, about 65,719 gas, R2 is about 662,912 a swap, 43 percent of
   R1. The price was latency: R2's note was spendable 12 blocks later, when B1 came.
5. **A batch over leaves the registry did not take in: held, for half.** F5 swapped two leaves, and
   the registry's `VERIFY` reverted, so node A refused it. A batch whose proof is for another root
   was **not sent**: the runner forges only the leaves. The registry passes its stored root into the
   proof's public inputs, so such a proof fails the Groth16 check by construction, not by run.
6. **R3 against R2: held.** The round used 1,038,424 gas for four owners, 259,606 each, and with
   an eighth of a batch for each owner's note about 325,325, 49 percent of R2's. One proof covered
   the four.
7. **A round with a spent note is refused at the node: held.** Node A's log names
   `ErrNonceTooLow`; the chain's simulation said "Nonce mismatch: expected 1, got 0", the key R2 had
   used.
8. **Every output note is a note: held.** The claimed note (R0), the completed notes (R1, R2, one
   of the round's) and the refund note were each spent with an ordinary proof to a fresh account,
   which then held exactly the note's value (the ether one less the fee).

**Costs, measured** (gas used; execution and state gas by frame):

| Transaction | Gas | Root (EIP-8272) | Registry `VERIFY` | Registry `SENDER` |
|---|---|---|---|---|
| R0a, spend and export with a receipt | 626,206 | 5,579 | 233,437 / 97,920 | 69,789 / 195,840 |
| R0b, claim | 1,412,863 | | 214,788 / 97,920 | 981,901 / 97,920 |
| R1, spend, swap, completion, insertion | 1,555,433 | 5,579 | 233,437 / 97,920 | 1,096,924 / 97,920 |
| F3, the refund instead | 1,463,599 | 5,579 | 233,437 / 97,920 | 1,005,078 / 97,920 |
| F2, completed twice, then the refund | 2,474,499 | 5,579 | 233,437 / 97,920 | 2,016,074 / 97,920 |
| R2, spend, swap, completion, append | 597,193 | 5,579 | 233,433 / 97,920 | 138,724 / 97,920 |
| R3, four owners | 1,038,424 | 5,579 | 294,499 / 391,680 | 317,109 / 0 |
| batch of eight (B1; B0 wrote one more fresh slot) | 525,754 | | 270,191 / 97,920 | 37,397 / 97,920 |
| payout of a token note | 478,188 to 489,802 | 5,579 | 232,853 to 232,855 / 97,920 | 33,017 / 97,920 |

| Configuration | Transactions a swap | Proofs | Gas per owner |
|---|---|---|---|
| R0, receipt and claim | 2 | 2 | 2,039,069 |
| R1, one transaction | 1 | 1 | 1,555,433 |
| R2, appended | 1 and an eighth of a batch | 1 and a share of one | about 662,912 |
| R3, a round of four | a quarter of 1, and an eighth of a batch | a quarter of one | about 325,325 |

- The state gas is a fresh slot each: a nonce key in `VERIFY` (one a spend, four a round), and in
  `SENDER` whatever slot the step wrote for the first time. R2's was the appending registry's first
  token balance, which R3 then did not need, so R2 carries one fresh slot a steady state would not.
- Every `VERIFY` above is over EIP-8141's public-mempool `MAX_VERIFY_GAS` of 100,000, from 214,788
  for a claim to 294,499 for a round. They fit the test network's 500,000, as in experiments 07 to
  14.
- A spend's `SENDER` frame carried 740 bytes of data.
- A failed swap costs about what a good one does, and the destination that completed twice cost
  more than either, because the registry did the insertion it then undid. The registry's float
  pays, so its fee has to cover the failure, not just the swap.

**Proving, on one machine:** a spend's proof (snarkjs) 3.5 to 4.7 s, a claim's 0.47 s, a batch's
4.7 to 4.9 s. The round's committee, three co-circom processes over loopback TCP with TLS, a LAN
time at best: about 0.06 s for each owner to split its input, 2.0 to 2.3 s for each member to
merge the four, 10.5 s for the witness and 6.0 s for the proof. 56,698,729 bytes crossed the
loopback interface while it ran. That also counts the two mempool nodes' traffic in the same
window, so it is an upper bound on the members'. The three members' proofs were identical, and the
proof verified.

**What became public,** read from the receipts and the calldata:
- the destination (the AMM), the asset in and the amount in;
- the asset out and the amount out: the completion event and the token transfer both carry it;
- the minimum out, and the partial note's inner value;
- in R3, that four notes of one denomination were spent together, and that each got the same share.
  The round's output did not divide by four: 2 of the token's smallest unit stayed with the
  registry.

The owner's address appears nowhere. The AMM saw the registry as its caller.

**Findings:**
- **The completion is what makes the single transaction safe.** The checks that refused the four
  destinations (caller, in-flight export, once, the minimum, the balance rise) are the whole
  defence: the proof cannot know the amount out, so the registry has to check what it received.
- **The refund note turns a spend that cannot be undone into one that is never lost.** Five failures
  were mined, each used its nonce key, and each returned the input as a note its owner then spent.
- **Latency is set by whoever sends the batch.** Here it was the runner, after the round and the
  refusals. A registry that pays the batch sender from its fees would set it by volume.
- **Equal shares are a disclosure.** A round reveals its size and its split. Unequal shares would
  need the amounts in the proof, or a second completion step.

### Passes that stopped

Four earlier deployments are on the chain, unused or partly used. None changed a prediction.
- **d1**: a read just after the deployments reached an RPC node without the registry's code, and
  the runner stopped before its first step. Reads now wait for nodes that agree (`85c4118`).
- **d2**: the deposits used about 3,000 gas each and added no leaf. The registry's constructor read
  its mode after copying the runtime over the memory it read from, so the runtime's first word was
  wrong. Fixed at `992cdd9`, which also has the runner check `mode()` and the leaf counts before it
  sends the registries any ether. About 0.07 test ether stayed in d1's and d2's contracts.
- **d3**: R0a was mined with a refund instead of a receipt. The pool held so much of the token that
  the output, about $4.7 \times 10^{22}$, was over the 64 bits a note's value has, and the registry
  refused the receipt. The refund note was added (block 602,026, 1,479,314 gas): prediction 3 seen
  by accident. Fixed at `6dbbc27`, with one token of liquidity and a check that a round's quote
  fits.
- **d4**: every step was mined or refused as predicted, then the runner failed to write its record:
  `results/` did not exist. Fixed at `269fba1`, which also keeps the nodes' log lines (they had been
  empty in every record, since the helper was handed the log's contents rather than its path). The
  run was repeated as d5 rather than rebuilt from receipts. d4's log gives a second observation:
  every step's gas was within 60 of d5's (R0a 626,158, R0b 1,412,851, R1 1,555,385, R2 597,205, R3
  1,038,436, B1 525,754), the calldata differing with the deployment's addresses, and F7 and F5
  were refused the same way.

### Transactions

| Step | Transaction |
|---|---|
| R0a | [`0x398f975a...`](https://dora.privacy.ethrex.xyz/tx/0x398f975adf08ae5febbf7100191a12865963c968b22fc5f64d51ee1cd5b6fb79) |
| R0b | [`0x89238a2e...`](https://dora.privacy.ethrex.xyz/tx/0x89238a2ea0d5ad32395feda2f3691bab7f75bf1f8e55cd71dc1d1e4945ca92d5) |
| R1 | [`0x8e6ea69c...`](https://dora.privacy.ethrex.xyz/tx/0x8e6ea69c9b16efa9a1acd33d510b45854eec76a113e20ce9e53628c84bfa5628) |
| F3 | [`0x775cab45...`](https://dora.privacy.ethrex.xyz/tx/0x775cab4554121db87e4ae641f76025cf72fc9be5f75812d34f4b03324eee3950) |
| F2, underpay | [`0x15434066...`](https://dora.privacy.ethrex.xyz/tx/0x15434066ff56d938ecec748251313385b75bbe59d748c8582bfe5eb50575518c) |
| F2, twice | [`0xc2e30e9c...`](https://dora.privacy.ethrex.xyz/tx/0xc2e30e9ca4ebec2e06a129e9c551e98d471d3df38d54b5603547ddaab9f3b958) |
| F2, relay | [`0xa4facfee...`](https://dora.privacy.ethrex.xyz/tx/0xa4facfee0d8047b3b5469287b772accd9e34525568e9cda4f3a98969412970b9) |
| F2, silent | [`0xd2981384...`](https://dora.privacy.ethrex.xyz/tx/0xd2981384d3bbf079ff08ff4e3bef9af38191631e7b48ee4574ef9abcc7b32b24) |
| P8a | [`0xad9b2a3a...`](https://dora.privacy.ethrex.xyz/tx/0xad9b2a3a2af049d3f79cc868b28b49747efcb08cb8ca2344444b2971876359aa) |
| P8b | [`0x84daa4ce...`](https://dora.privacy.ethrex.xyz/tx/0x84daa4ce6cab49e15a80b78175a1934d470f9271650c3d626974300b73389205) |
| P8c | [`0x9d929ba1...`](https://dora.privacy.ethrex.xyz/tx/0x9d929ba19e3615d30826f347e8628a44f9424bbe94793d106350f30d326e8363) |
| B0 | [`0x742e696b...`](https://dora.privacy.ethrex.xyz/tx/0x742e696b4c70e31dc8871bf413d915c9874f678a6ec0c2b67420df9eefbc9472) |
| R2 | [`0x11620091...`](https://dora.privacy.ethrex.xyz/tx/0x116200915edfa884b409096b1f88b1f170eeb5f7890e92e4c963767479dcf907) |
| R3 | [`0x0140f627...`](https://dora.privacy.ethrex.xyz/tx/0x0140f62778fc49df4789bb4a299521b47391aa067e99de8ea245b313167db657) |
| B1 | [`0x91958e3b...`](https://dora.privacy.ethrex.xyz/tx/0x91958e3b3e7dc7e6936279070aca4254ede79dabac4c40eb1481905542743273) |
| P8d | [`0x402bd9b3...`](https://dora.privacy.ethrex.xyz/tx/0x402bd9b30c3367df3e2371f06d7bb494764a7cc8720fd1a26328b5ab780274d7) |
| P8e | [`0xf3dd5970...`](https://dora.privacy.ethrex.xyz/tx/0xf3dd5970c759b2786406231784e5e28b603de71d83ea36c237a785ce68ac2381) |

The test network's relaunches void these links; the fixtures keep the transactions.
