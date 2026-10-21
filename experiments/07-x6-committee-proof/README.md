# Experiment 07: a proving committee in place of an operator, and what it can still hold

**Status: run.** The claim, what would show it wrong and the plan were committed before any
transaction (`546e349`), and the runner and checks before the first (`0561401`). Run 3 is the
record the results are read from (`results/3-third-run.json`); runs 1 and 2 are below, with what
changed after each. In short: the claim's first condition is shown wrong by the wallet's pricing,
not by the proof; the second and third were not observed.

**The claim.** TACEO's co-SNARKs let a committee compute together the proof that the user's own
device would compute. Three things follow:
- **For one user's action,** the operator disappears. The committee's proof is the proof the
  device would have made, so the node and the verifier see nothing that tells them apart.
- **For state that users hold together,** the committee itself is the transaction's sender. Its
  proof is checked in its own `VERIFY` frame, and a separate payer approves the fee. Nothing else
  is needed in the prefix.
- **Once the committee stops,** no user can move what the committee held for them. A user who
  still could would show "missing" wrong in the good direction.

**What would show it wrong.** Any one of these:
- the committee's withdrawal differs from a device-proved one in anything a node or the
  verifier sees, beyond the proof's own random points;
- the shared-state update needs more in its prefix than the committee's proof and a payer's
  approval;
- after the committee stops, a user can still move a balance it held.

**A stand-in, stated before the run.** TACEO's private-balance circuit is not public. The
shared-state update is therefore proved over the circuit the committee already proves: the
privacy pool's withdrawal circuit, from experiment 01. The committee's account keeps its own
copy of a note tree's root, and the chain's own nonce keys serve as its set of spent nullifiers.
An update spends a note the committee holds in shares, proved by the committee, and moves an
internal balance to the proof's recipient.
This tests the sender, proof and payer shape that a committee's shared state takes on chain. It
does not test a balance circuit.

## Pieces

| Piece | Role |
|---|---|
| exp-e2e-frames `committee/co-withdraw` | three members proving with co-snarks over shares of a witness |
| kohaku-rs, `kohaku-witness-share` and `kohaku-frame-pool` | the wallet's side: a deposit, the witness in the committee's share format, and the withdrawal around the committee's proof |
| skandha | two nodes with frame transactions on. B alone hands transactions to the chain |
| chain | the ethrex Hegota testnet, chain 8141. Experiment 01's refund pool and the verifier it calls are reused |

Each is pinned at a full commit in `pins.json` when the runner lands.

## The plan

1. **Two nodes,** A and B, peered with each other only. Every transaction below is sent to
   node A, except deployments and deposits, which go to the chain directly.
2. **A withdrawal proved by the committee.**
   - A note is deposited into the refund pool.
   - Its witness is shared to three members, who prove it.
   - The withdrawal is sent and mined.
   - It is set beside a withdrawal the device proved alone, frame by frame: limits, gas, bytes
     and the verifier's answer.
3. **A shared-state update with the committee as sender.**
   - The committee's account is deployed.
   - A note it holds in shares is deposited.
   - The committee proves the update.
   - The account's `VERIFY` frame checks the proof and approves execution, and a payer's frame
     approves the fee.
   - It is mined.
4. **The committee stops.** Its members' processes end and their shares are deleted. The run
   then records what a user can still do:
   - with what the wallet kept;
   - with the chain alone;
   - with any one member's share.
5. **The record.** For every transaction it keeps:
   - its bytes and hash;
   - each node's log lines for it;
   - whether it was mined, and if so its block, status, payer and gas by frame;
   - the members' messages and bytes per proof.

   It keeps no key, share or note secret.

## Amended before the first transaction

The runner (`run.ts`), its Rust half (`rust/`), the account (`contracts/CommitteeAccount.yul`)
and the checks (`test/x6.test.ts`) make the plan concrete. Where they differ from the plan's
words above, this is what runs:

- **No deposit for the stand-in.** The account's tree is three fresh notes that exist only
  off chain. Its root is appended to the account's code at deployment, and the committee holds
  the second note in shares. So step 3 deploys the account and funds a fresh payer in one
  transaction, and deposits nothing.
- **The spent set is the nonce-key table.** The update's only EIP-8250 nonce key is the note's
  nullifier hash, at sequence 0. The account's `VERIFY` checks that, and stores nothing.
- **The account's ledger.** One unit is credited to the proof's recipient, in a mapping the
  account keeps. The proof's relayer, fee and refund must be zero.
- **Step 4, made concrete.** A third note is deposited into the refund pool, and its witness
  shared, but it is never proved. Two members' shares are deleted. Member 0 is then started
  alone with its share, with a time limit, and its exit is recorded; then its share is deleted
  too. The run records which files the wallet kept, and sends node A the note's withdrawal with
  256 zero bytes in place of the proof: what the chain alone allows.
- **The device's withdrawal** is kohaku-rs's `refund_withdrawal`, which proves on this machine
  and prices its limits from a simulation. The committee's is built by the runner from
  `share_withdrawal`'s output at the pool's default limits, with the worst-case fee. The two are
  compared field by field as the plan says. Any difference shows the claim's first condition
  wrong, whatever its cause.

## Run 1, and what changed before run 2

**Run 1** (2026-10-21, about 08:00 to 08:06 UTC) stopped at the update, and wrote no record:
the runner kept everything for one record at the end. From its output and the chain:
- the device's withdrawal was mined in block 494,616, 579,661 gas;
- the committee's withdrawal (`0xb6ca532d...`) was mined in block 494,621, 579,685 gas, and the
  same bytes sent again were refused with `ErrNonceTooLow`;
- the account was deployed and its payer funded in block 494,624;
- the update was refused: the chain's simulation found it invalid, "validation prefix frame
  reverted". Nothing of it was mined.

**The cause.** EIP-8141's default code (ethereum/EIPs `258836f9`, "Default code") reads the
signature of a `VERIFY` frame at index 0 when its scope includes execution, and at index 1
otherwise. The payer approves payment only, so its signature must sit at index 1. The runner
put it at index 0, its only entry, and the payer's default code reverted.

It was found without sending anything further to a node:
- simulating the update with the payer frame's state gas raised did not help;
- simulating it against a copy of the account that approves before its first check did not
  help either, so the account's checks were not the cause;
- with an empty `ARBITRARY` entry at index 0 and the payer's signature at index 1, the update
  is valid with every check run. The account's `VERIFY` used 245,351 gas, the payer's 3,000 and
  the credit 13,924.

Those probes deployed five accounts and funded their payers (blocks 494,660 to 494,727). No
update was sent to a node. The client refused an `ARBITRARY` entry that names a signer, so
the entry names none and resolves to the sender. The account's `VERIFY` never reads it.

**Changed before run 2:**
- the update carries two signature entries: the empty `ARBITRARY` one at index 0, and the
  payer's at index 1;
- the record keeps each signature entry's scheme, signer and length. The check of the update's
  signatures says two entries, as above, where it said one;
- the runner writes what has finished under `results/failed/` when a later part throws, and
  runs the Rust half without backtraces, so that its message survives;
- the Rust half prints the chain's simulation when a node's answer is not the one expected.

Whether the empty entry is "more in its prefix than the committee's proof and a payer's
approval" is reported with the results, not decided here. It is a protocol rule about where a
payment-only signature goes, and it costs the prefix 100 gas.

## Run 2, set aside for two defects in its record

**Run 2** (2026-10-21, 08:18 to 08:20 UTC, record `results/superseded/2-second-run.json`)
ran every part:
- the committee's withdrawal was mined in block 494,757, and its replay refused;
- the update was admitted by node A, gossiped, handed on by B and mined in block 494,761, its
  recipient credited with one unit, and its replay refused;
- the held note's withdrawal without a proof was refused, `ErrFramePrefixReverted`.

Its record has two defects of this runner's, so it is kept, not read for the results:
- **The update's member records were overwritten.** The Rust half records its own `members`
  field, the member ids, and the runner spread it over the members' records. The update's
  proof and inputs are on chain and in the record's other fields, but that proof's messages
  and bytes are not.
- **The member-alone probe tested nothing.** `co-withdraw member` takes `--peers` as three
  separate values; its help text says comma-separated, and the runner passed one
  comma-separated value. The member exited on its command line, before trying to reach a
  peer.

**Changed before run 3:**
- the runner keeps the member ids as `memberIds` and the members' records as `members`;
- the member-alone probe passes the three addresses separately, and its check refuses a
  command-line error;
- the device's public inputs are recorded, decoded from its mined withdrawal.

**The comparison, shown wrong in run 2.** The check written before run 1, that
a node sees every frame, limit and fee field alike, is kept verbatim. It is marked as expected
to fail, and a new check states what matched and what did not:
- matched: the frames' modes, scopes, targets, values, data lengths and selectors, the fee
  fields and the absence of signatures;
- differed: the frames' gas limits. The device set its limits from a simulation of its own
  proof. The wallet's shares carry none to simulate, so the committee's withdrawal uses the
  pool's defaults and the worst-case fee.

## Results, run 3

Run 3 (2026-10-21, 08:22 to 08:25 UTC), against
`ethrex/v23.0.0-hegota-testnet-hotfix-64b8fc09` as `web3_clientVersion` reported it. Every transaction below went to node A, and
node B alone handed transactions to the chain. `npx vitest run test/x6.test.ts`: 13 checks pass,
and the check written before run 1 as the first condition fails, as it is marked to.

**1. A withdrawal proved by the committee, beside one the device proved.** Both were sent to
node A. Each reached B only by gossip, B passed it to the chain, and each landed unsigned, the
refund pool its sender and payer. The verifier the pool calls accepts both proofs.

| Frame | Device's limit | Committee's limit | Gas used, both |
|---|---|---|---|
| 0, `VERIFY` the recent root | 11,973 | 10,000 | 5,579 |
| 1, `VERIFY` the proof, execution and payment | 310,930 | 400,000 | 244,744 + 97,920 state |
| 2, `SENDER` withdraw | 100,000 | 100,000 | 14,255 + 183,600 state |
| 3, the refund | 25,000 | 50,000 | 11,531 |

Both used 579,673 gas in all: the device's in block 494,793, the committee's in block 494,798.
The fee fields, the frames' modes, scopes, targets, values, data lengths and selectors are the
same. The limits are not, and nor is the fee the proof commits to, a public input: 150,658.2
gwei for the device, 173,077.6 gwei for the committee (150,658,200,000,000 and
173,077,600,000,000 wei; corrected after run 3, which first gave these wei figures as gwei).

- **So the first condition is shown wrong, and the cause is the pricing, not the proof.** A
  wallet that proves for itself simulates its draft and tightens the limits (kohaku-rs's
  `refund_withdrawal`). A wallet that hands its witness to a committee has no draft to simulate,
  and uses the pool's defaults and the worst-case fee (`share_withdrawal`). A node sees the
  difference in the clear. Whether a device at the defaults would be indistinguishable was not
  tested; the gas used, frame for frame, says nothing else would differ.
- **The committee.** Three members on loopback TCP, one machine. Each proved in about 1.43 s,
  1.66 s for all three with connecting. Each sent its two peers six messages in all, 752 to 784
  bytes. Each held a share of 1,811,012 bytes of the 28,300-value witness.

**2. The shared-state update, the committee as sender.** The account (610 bytes of code: the
569-byte runtime with the stand-in's root and the verifier appended) was deployed, and a fresh
payer funded, in block 494,800. Node A admitted the update and B, which heard it
by gossip, passed it to the chain: block 494,802, 481,166 gas, paid by the payer. The recipient's balance in the
account's ledger reads 1. The same bytes again were refused, `ErrNonceTooLow`.

| Frame | What | Limit | Gas used |
|---|---|---|---|
| 0, `VERIFY` the account, execution | the committee's proof, checked by the pool's verifier | 300,000 | 244,273 |
| 1, `VERIFY` the payer, payment | the protocol's default code, its signature at index 1 | 10,000 | 3,000 + 97,920 state |
| 2, `SENDER` the account | `credit(recipient, nullifierHash)` | 60,000 | 13,924 + 97,920 state |

The 97,920 in frame 1 is the nullifier hash's first use as a nonce key, which EIP-8250 charges to
the frame that approves payment.

- **The second condition is not observed.** The prefix is the committee's proof in the account's
  own `VERIFY` and the payer's approval, nothing else. The one addition is a protocol detail:
  index 0 of the signature list carries an empty `ARBITRARY` entry, because the default code
  reads a payment-only signature at index 1 (run 1). It costs the prefix 100 gas.
- **Against the budgets.** The account's `VERIFY` fits the testnet's 500,000 and is about 2.4
  times EIP-8141's 100,000, as the pool's is.

**3. The committee stopped.** A third note was deposited and its witness shared, never proved.
- **One member's share:** member 0, started alone with its share, exited with "timeout while
  connecting to party 1". It cannot prove alone.
- **What the wallet kept:** `public.json` and `withdrawal.json`, the public inputs and the
  withdrawal's layout. No share, and no note: the note is printed to standard error once,
  before the deposit, and the runner drops it, as a wallet that hands its witness away would.
- **The chain alone:** the note's withdrawal with zeros in place of the proof was refused by
  node A, `ErrFramePrefixReverted`, never gossiped and never mined.

So the third condition is not observed: after the committee stopped, nothing this run had moves
the held note, which stays in the pool. Two members together were not tried. Experiment 53 of
exp-frames measured that any two of three such share files rebuild the witness, so "the
committee stopped" is safe for the user only if the members' files are gone, and unsafe for the
user's privacy for the same reason if they are not.

**What this does not show.** One run of each part, on one machine, the members as threads of one
process. The stand-in is the withdrawal circuit, not a balance circuit. The account trusts the
committee's proof for any recipient the proof names, and the run does not show who may ask the
committee to prove.


## Addendum: one pricing for both routes, written before its code or any transaction

Run 3 showed the first condition wrong by the wallet's pricing, not by the proof. The device
set its gas limits from a simulation of its own proof, and the committee's shares were priced at
the pool's default limits with the worst-case fee. The wallet's authors proposed one pricing for
every route, and this addendum tests it. Run 3's record and its checks stay as they are.

**The change, in kohaku-rs.** `kohaku-frame-pool` prices every withdrawal by default at the
pool's default limits, with the fee its worst case at those limits. The tighter pricing from a
simulation stays, as an explicit opt-in. The commit is pinned in `pins.json` when it lands, and
this section is not edited after that.

**The claim.** Under the new default, a node sees the committee's withdrawal as it sees the
device's. Every field a node can read is the same in the two transactions:
- the signature count, the number of nonce keys and both fee fields;
- for every frame: its mode, flags, target, gas limit, state gas, value, data length and
  selector;
- the fee the proof commits to.

What may differ is what the two notes and recipients make differ: the nullifiers, the recipient,
the proof's bytes and every hash taken over them. If the pool's root moves between the two
proofs, the root differs too, and the runner proves both against one root to keep it out.

**What would show it wrong.** Any one of these:
- a field listed above differs under the default;
- the device's withdrawal at the defaults is refused by node A, or reverts once mined;
- the unused gas is not refunded, so the device's withdrawal under the default costs its note
  more than run 3's did by more than the fee the refund returns. The runner records both
  costs.

**The plan.** The pieces of run 3, except kohaku-rs at the new commit:
- the same circuit, proving key, verifier and pool;
- the committee of three, as in run 3.

One note is withdrawn by the device and one by the committee, each with no pricing option set.
Each is sent to node A, and B alone hands it to the chain. The record is
`results/4-pricing-addendum.json`. The offline checks select by record: run 3's keep their
expected failure, and the addendum's record must pass the same comparison as a plain check.
The update and the stopped committee are not rerun.

**Amended before the addendum's first transaction, with its code.**
- **Where each transaction is built.**
  - kohaku-rs is pinned at `bf818dc` for its two examples: the device's `refund_withdrawal`,
    run with no `PRICING`, and the wallet's `share_withdrawal`.
  - The committee's transaction is still assembled by this experiment's runner, as in run 3.
    It uses `withdrawal_tx` at the pool's default limits, from the kohaku-rs commit that
    `committee/` links (`ab056ab`), so that the build holds one copy of those crates. Those
    defaults are what the new commit makes every route's default.
- **The root.** Each example deposits its own note and proves at once, so the two proofs name
  different roots. The runner does not hold them to one root. The root is outside the fields
  compared, as the claim allows.
- **The cost, exactly.** The device example prints the fee, the gas charged and the refund. The
  note's net cost is the fee less the refund. The refund is shown not to work if the net cost
  under the default exceeds run 3's by the whole rise in fee, which is what no refund at all
  would cost. The check reads run 3's line from its record.
- **The run** is `npx tsx experiments/07-x6-committee-proof/run.ts 4-pricing-addendum
  --pricing-addendum`.

