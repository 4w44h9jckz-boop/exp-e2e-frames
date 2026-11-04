# Experiment 20 (Q6): committee signatures after a quantum computer

**Status: pre-registered 2026-11-04,** before any contract, runner, key or transaction. The
claim, the predictions, what would show each wrong and the plan are fixed here; results are added
below them, and nothing above the results is edited after a run.

**Why now.** Ethereum's post-quantum target is December 2028, as Justin Drake gave it at
Devcon 8; the September roadmap had December 2029. Every committee in these experiments signs
with a key a quantum computer could forge: threshold BLS12-381 in X5 (experiment 06) and X9
(experiment 14), and ECDSA in X11's attesters (experiment 16). This experiment gives each a
hash-based successor and measures what it costs and what it loses. The classical records stay as
they are; the runs here are new runs beside them.

## The claim

Every committee signature in these experiments has a hash-based successor that the chain checks
within its budget. A committee of $n$ members, $q$ of whom must sign, signs as $q$ named
leanSPHINCS signatures. Each is declared as an EIP-8288 dependency, and one recursive proof per
block, leanVM's aggregation, makes them all true. The contract's `VERIFY` checks only that the
declared dependencies name at least $q$ distinct members of its committee, on its message.

What this loses is recorded, not argued away:
- **The hidden signer set.** A threshold BLS signature does not say which members signed. Named
  signatures do: every observer learns which $q$ members signed each statement.
- **One key that outlives its members.** Experiment 08 reshared one BLS key to new committees
  without the chain noticing. A set of named keys has no reshare: a new member means a new key the
  contract must learn.

## What would show it wrong

Any one of these, in any arm:
- a committee check does not fit its budget: a `VERIFY` frame over the nodes' 500,000 gas with its
  declared dependencies counted, or a check whose transaction is not mined;
- a set below the quorum is accepted: fewer than $q$ named signatures, one member counted twice, a
  key outside the committee, or a signature on another message, admitted by a node or paid on chain;
- the block proof over a run's signatures cannot be built on the local chain on this machine.

## Two conditions, stated in every result

- **leanVM has no zero knowledge yet.** Nothing here claims privacy from a leanVM proof. The
  signer set is public by construction anyway, which is this experiment's loss.
- **EIP-8288 as written.** leanSPHINCS dependencies are valid at EIP-8288's master, so the local
  chain runs the EIP as written, with no extension. `LEANSTARK_SCHEME` is not used.

## The tools, pinned

As experiment 19 pinned them, and from its branch: leanVM at `3cbac04` with its leanSPHINCS
(32-byte keys, 7,740-byte signatures, "not the definitive parameter set"), experiment 19's
`prover/` built with `-C target-cpu=native`, `lean.ts`, and `local.ts` with `ethrex.sh` and
`ethrex-8288.patch`: ethrex at the test network's commit, `64b8fc09`, with EIP-8288's dependency
frame and block proof patched in.

## Arms

For each committee, a contract like the classical one, with its signature check replaced. The
committee's member keys are in the contract's code. A dependency frame (EIP-8288's mode 4) carries
the triples $(\mathtt{0x10}, m, \mathit{pk}_i)$; the contract's `VERIFY` requires at least $q$ of
them, each naming a distinct member, in increasing member order, on its message $m$.

1. **X5's result,** $q = 3$ of $n = 4$: experiment 06's `ResultBoard`, with $m$ the keccak256 of
   its fixed message (chain ID, request, result handle, value) under a domain tag.
2. **X9's reconciliation,** $q = 3$ of $n = 3$: experiment 14's `ExitVault`, with the threshold
   BLS check in `reconcile` replaced. Everything else in the vault is unchanged, and escape is
   opened with a stall and a redemption, as experiment 14's runner does.
3. **X11's settlement and slash,** $q = 3$ of $n = 4$: experiment 16's `ReadPool`, with its ECDSA
   quorum replaced for settlement and refund, and its slashing evidence, one member's two
   conflicting signatures, declared as two dependencies under that member's key.
4. **Refusals, for each arm:** two signatures of three; one member's signature declared twice; a
   key outside the committee; a signature on another message. Each must be refused at the node.
5. **Aggregation.** On the local chain, every block holding these transactions is proved by
   leanVM's aggregation before it is built on. Off chain, the prover aggregates 3 to 64
   signatures, to say how many committee statements an interval holds on this machine.
6. **The two losses, measured.**
   - For every mined committee transaction, which members an observer learns, against the
     classical record, where a BLS signature named none.
   - What replacing one member costs: a new contract or a key update, in gas, against experiment
     08's reshare, which changed nothing on chain.

Each arm runs on the local chain as EIP-8288 is written, and on the test network with EIP-8288
modelled, as experiment 19 did. On the test network, the triples travel in the `VERIFY` frame's
data, the signatures are checked and aggregated off chain by the prover, and the reported gas is
the measured gas plus 3,000 per declared leanSPHINCS dependency. Every figure says which.

## Predictions

| # | Prediction | Would show it wrong |
|---|---|---|
| 1 | Each named check fits: `VERIFY` uses under 60,000 gas of execution plus 3,000 per declared signature, against the classical check's cost in its record | a check over the budget, or over 60,000 plus the declared gas |
| 2 | Every refusal in arm 4 is refused at the node, on both chains | one admitted, or one paid |
| 3 | Every local block holding these signatures is proved by leanVM's aggregation within the local chain's slot | a block that cannot be proved, or not in time |
| 4 | An observer names the signers of every committee transaction, as the classical records named none | a committee transaction whose signers cannot be read from its own data |
| 5 | Replacing one member costs a deployment or a key update, measured in gas, where experiment 08's reshare cost nothing on chain | a member replaced without anything on chain changing |

## C3's case: a key that signs once per epoch (derived, not run)

The register asks for a threshold leanXMSS key for a committee that signs once per epoch, for
experiment 08's case. That construction exists, measured elsewhere, and is not public, so it is not
rerun here; its figures are cited in the project's own records, and here it is described only as
"a threshold leanXMSS construction, measured elsewhere".

- **The question:** which of experiment 08's signatures a key that signs once per epoch can make,
  and what it costs to give a new committee such a key, against experiment 08's reshare.
- **Expected, stated now:** it cannot make the ticket issuers' signatures, which are many per
  epoch; it fits one statement per epoch, such as a committee naming its successor. Re-keying a
  production-size key costs orders of magnitude more compute and bandwidth than experiment 08's
  reshare at 256 members (6.3 s of compute a member).
- **What would show it wrong:** a signature experiment 08 makes many times per epoch that the
  once-per-epoch key can make; or a re-keying no costlier than the reshare.

## Done when

X5's, X9's and X11's committee checks each have a post-quantum run on both chains, or a stated
reason; every refusal is recorded; and the two losses are measured, with C3's case written from
the cited figures.

## Results

None yet.
