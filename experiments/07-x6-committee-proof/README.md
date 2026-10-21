# Experiment 07: a proving committee in place of an operator, and what it can still hold

**Status: written before any transaction.** This README states the claim, what would show it
wrong and the plan. The runner and the offline checks are in the same commit as this status
line, pushed before the first transaction. The plan was made concrete in that commit; the
changes are listed under "Amended before the first transaction" at the end.

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

