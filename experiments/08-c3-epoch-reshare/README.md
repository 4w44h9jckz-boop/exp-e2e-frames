# Experiment 08: one ticket key, a new committee each epoch

**The claim.** A committee scoped to an epoch can hand its key to the next without the chain
noticing. Resharing the key from a quorum of one committee to a freshly drawn one keeps the
group key, so the ticket paymaster's code, and every node's check of a ticket against the key in
that code, stay the same. It tests two published sentences:
- the post *Who does what after the rollup*, guideline 7, "Scope every committee": "One
  function, one evaluation, a deadline. A committee that must hold a key for years is a
  persistent operator, and owes its users rotation and an exit";
- Appendix F, *Escape the Matrix*: "Short-lived secrets held by sampled committees work well
  enough".

**What would show it wrong.** Written before the first run, as the checks in
[`test/c3.test.ts`](../../test/c3.test.ts), and pushed before the first transaction:
- a reshare changes the group key, so a later committee's ticket does not verify under the key
  in the paymaster's code;
- a new committee cannot sign: its ticket is refused by the node or not paid by the paymaster;
- a reshare to `n` members takes a member longer than an epoch (384 s), at the committee sizes
  the posts name: 3-of-5, 7-of-10, 13 nodes, 256 seats. A member's time is its own compute,
  every member run in turn on one machine, plus three one-way trips of 150 ms for the protocol's
  three rounds.

**Recorded either way:** whether a committee that kept its shares after handing the key on can
still sign. If it can, ephemerality rests on erasure that nothing enforces.

**Amended before the run that counts** (the owner's word, through the coordinator, 2026-10-21):
- **The expected outcome, stated now:** the first committee's kept shares will still sign
  under the key after both handoffs (derived: a reshare gives new shares of the same secret and
  erases nothing). So under one key, "the chain does not notice the handoff" and "the old
  committee can no longer sign" cannot both hold.
- **A second arm, B:** in the same epochs, a fresh DKG among fresh members each epoch, its key
  registered with the chain by a transaction that deploys and funds a ticket paymaster for it.
  There the chain does notice each handoff, and the first committee's kept shares are tried at
  the paymaster of the latest key.
- **Both arms report** rounds and messages first, then bytes, then wall-clock with the network
  it assumed.

A first chain attempt (from `525b303`) was stopped before any spend when the amendment arrived;
only its setup transaction was mined, and its record was not written.

**Reporting added later (2026-10-21, the owner's word through the coordinator)**, beside the
results; the claim and the checks above are unchanged:
- committee sizes up to 423 and 512, by `member` mode below;
- a comparison of the bytes a dealer sends with `32n + 48t`, the per-dealer figure derived in
  the post *Evolving Committees at the Mempool Level* (`t` the faults tolerated here, `n - q`);
- the resharing library's commit: Commonware `v2026.9.0` (`d476a23`) with this experiment's
  `dkg::feldman_desmedt::run` on top, cmw-monorepo `489e313`;
- that kept shares still sign is a certainty shown, not a hypothesis tested: a reshare gives new
  shares of the same secret.

## Pieces

| Piece | Pin (`pins.json`) | Role |
|---|---|---|
| kohaku-rs | `ab056ab` | `kohaku-frame-ticket`: blind issuance from any share, the `TicketPaymaster` the node recognises by its code, and the spend. Unchanged since experiment 04's `eea02a3` |
| cmw-monorepo | `489e313` | Commonware `v2026.9.0`'s Joint-Feldman DKG and Desmedt resharing (`dkg::feldman_desmedt`), with `run`, which counts each member's messages, bytes and compute. Patched in for every `commonware-*` crate, kohaku-rs's included |
| skandha | `2b1b4b0` | two nodes with `--frames.claims`, as in experiment 04: a node has no list of paymasters or keys, and checks a ticket against the key in the code of the paymaster its frame targets |
| chain | ethrex `hegota-testnet-hotfix` at `64b8fc09` | simulates each validation prefix for the nodes, and builds the blocks |

## The run

`chain`, arm A:
1. **Committee 0**: four members, by Commonware's DKG, each a dealer and a player (quorum 3).
   One transaction from the funder deploys one `TicketPaymaster` with its key and buys four
   tickets at 0.001 ETH. Neither node is told the address or the key.
2. **Three rounds, each in a later epoch than the one before.** Round `k > 0` opens by resharing
   the key from a quorum of committee `k - 1` to committee `k`, all fresh members: seven
   (quorum 5), then ten (quorum 7). Each round, its committee issues one ticket blindly to the
   funder for a fresh sender's first slot, every answer checked against its member's public share,
   and the spend goes to node A. Node A checks the ticket, asks its client, and gossips the spend
   to node B, which hands it to the chain. The next round waits for the spend to be mined.
3. **The retired committee**: in a later epoch, a quorum of committee 0, which kept its shares,
   issues a fourth ticket, spent the same way.

`chain`, arm B, interleaved with arm A in the same epochs: committee B0 (four members, DKG) and
its own paymaster are set up in the same first transaction, with one ticket. In each later
round a fresh DKG makes committee B1 (seven) or B2 (ten), and one transaction from the funder
registers its key: it deploys a ticket paymaster with that key and buys one ticket. Each round's
B committee issues a ticket spent through its own paymaster. In the last epoch, B0's kept shares
issue a ticket for B2's paymaster.

`measure`: for each size `n` in 4, 5, 7, 10, 13, 16, 32, 64, 128 and 256, a DKG among `n`
(arm B's cost each epoch), then a reshare from a quorum of them to `n` fresh members (arm A's),
in memory, every participant run in turn. For each participant: rounds and messages, then bytes,
then compute time; a member's wall-clock is its compute plus three one-way network trips.

```text
 TICKET-PAID SPEND    sender = a fresh key (no ether, no code, nonce 0)   signatures = [sender]
 ----------------------------------------------------------------------------------------------
 [0] VERIFY -> sender       default code: APPROVE(EXECUTION)
 [1] VERIFY -> paymaster    the ticket: epoch (8) || salt (32) || BLS12-381 G1 signature (128),
                            checked against the key in the paymaster's code, then APPROVE(PAYMENT)
 [2] SENDER -> board        post("C3: paid with a ticket from round k")
```

`member`, for 423 and 512, where running every member in turn would take hours: the previous
key is dealt by Commonware's `deal`, a quorum of its holders are the dealers, and one dealer deals
to `n` fresh players, every one of whom checks the dealing and acknowledges it. So the dealer's
log is the one a full round publishes. Exact: every message's encoded size, and the counts the
protocol fixes. Timed: the dealer's own work, and each player's check of one dealing. Derived: a
player's checks of all `q` dealings. Not measured: a player's finalization, and the other
dealers, each the same work as the one measured.

## Run

```bash
npm install
npm run account && npm run faucet
npx tsx experiments/08-c3-epoch-reshare/run.ts measure [attempt-label] [sizes]
npx tsx experiments/08-c3-epoch-reshare/run.ts member [attempt-label] [sizes]
npx tsx experiments/08-c3-epoch-reshare/run.ts chain [attempt-label]
```

Each writes `results/<mode>-<attempt>.json`. A `chain` record holds every transaction, both
nodes' log lines for every spend, each committee's key, size, quorum and identities, what each
round cost each member, and each ticket's answers, blinded. It holds no key, share or blinding
factor. `npm test` checks every record offline, and checks each ticket again with noble's
BLS12-381.

## Results

None yet: the claim and the checks above are pushed before the first transaction.
