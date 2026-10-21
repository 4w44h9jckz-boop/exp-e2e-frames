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

Three records, from this branch: `results/chain-2-amended.json` (from `0896276`,
2026-10-21, blocks 491,498 to 491,641), `results/measure-1-first-run.json` and
`results/member-1-first-run.json` (from `0adec74`, 2026-10-21). The library is Commonware
`v2026.9.0` (`d476a23`) with `dkg::feldman_desmedt::run` on top, cmw-monorepo `489e313`, in all
three. `npm test` passes on all three.

### The chain run

| Round | Arm A: reshare, one paymaster | Arm B: fresh DKG, a paymaster each |
|---|---|---|
| 0 | A0 (4, quorum 3) by DKG; spend mined in block 491,500 | B0 (4, quorum 3) by DKG; spend mined in 491,502 |
| 1 | A0 to A1 (7, quorum 5); spend mined in 491,523 | B1 (7, quorum 5) by DKG, registered at 2,434,267 gas; spend mined in 491,525 |
| 2 | A1 to A2 (10, quorum 7); spend mined in 491,585 | B2 (10, quorum 7) by DKG, registered at 2,434,267 gas; spend mined in 491,587 |
| later epoch | A0's kept shares: ticket admitted, spend mined in 491,640 | B0's kept shares at B2's paymaster: refused by node A, `ErrClaimInvalid` |

The first transaction (`0x1bd0fdbc...`, block 491,498, 4,848,907 gas) deployed arm A's paymaster
and arm B's first, and bought their tickets. Every spend came from a fresh sender with no ether
and was paid by its paymaster; each round ran in a later epoch than the one before.

- **The key did not change.** A1 and A2 hold A0's group key; their tickets verified under the
  key in the one paymaster's code, at both nodes and on chain. Not shown wrong.
- **Each new committee signed.** Every ticket was admitted by node A, gossiped to node B and
  paid by its paymaster. Not shown wrong.
- **The retired committee still signs, as stated before the run.** Arm A's A0, which kept its
  shares, issued a ticket after both handoffs, and the chain paid it. This is a certainty, not a
  finding: a reshare gives new shares of the same secret and erases nothing. Under one key, the
  chain not noticing a handoff and the old committee losing the power to sign cannot both hold;
  arm A's ephemerality rests on erasure that nothing enforces.
- **Arm B pays for noticing.** B0's kept shares were refused at B2's paymaster, also a certainty
  (a different key). The price is one registration a handoff, 2,434,267 gas here, and a paymaster
  and address the chain and every wallet must learn each epoch.

Each handoff, per member, in rounds and messages, then bytes, then time (all members in one
process, so no network time; three 150 ms trips would add 450 ms):

| Handoff | Rounds | Messages sent (largest member) | Bytes sent (largest member) | Wall-clock, all members in turn | Started into its epoch |
|---|---|---|---|---|---|
| A0 to A1 (reshare to 7) | 3 | 14 | 12,404 | 71 ms | 7 s |
| A1 to A2 (reshare to 10) | 3 | 20 | 24,470 | 205 ms | 7 s |
| B1 (DKG of 7) | 3 | 18 | 11,016 | 107 ms | 7 s |
| B2 (DKG of 10) | 3 | 27 | 22,599 | 258 ms | 7 s |

### Up to 256 members (`measure`)

Every participant run in turn in one process on one machine (4 CPUs, Xeon at 2.80 GHz); the
largest member's figures. In the reshare, a quorum of the old members deal to `n` new ones; in
the DKG, all `n` deal.

| n | quorum | DKG: msgs / bytes sent | DKG: member compute | reshare: msgs / bytes sent | reshare: member compute | reshare, all in turn |
|---|---|---|---|---|---|---|
| 4 | 3 | 9 / 3,483 | 10 ms | 8 / 4,388 | 9 ms | 34 ms |
| 5 | 4 | 12 / 5,800 | 12 ms | 10 / 6,930 | 19 ms | 82 ms |
| 7 | 5 | 18 / 11,016 | 19 ms | 14 / 12,404 | 18 ms | 111 ms |
| 10 | 7 | 27 / 22,599 | 26 ms | 20 / 24,470 | 28 ms | 235 ms |
| 13 | 9 | 36 / 38,232 | 31 ms | 26 / 40,586 | 43 ms | 460 ms |
| 16 | 11 | 45 / 57,915 | 44 ms | 32 / 60,752 | 61 ms | 778 ms |
| 32 | 22 | 93 / 233,275 | 170 ms | 64 / 238,752 | 225 ms | 5.6 s |
| 64 | 43 | 189 / 923,643 | 384 ms | 128 / 934,208 | 570 ms | 29 s |
| 128 | 86 | 381 / 3,699,129 | 1.4 s | 256 / 3,720,064 | 2.0 s | 213 s |
| 256 | 171 | 765 / 14,755,575 | 5.1 s | 512 / 14,797,056 | 6.3 s | 1,421 s |

- **Rounds**: three for every member at every size.
- **A member reshares well within an epoch at every size the posts name.** At 256 seats, a
  member's compute is 6.3 s, plus 450 ms for three WAN trips, against 384 s. Not shown wrong.
  Running all 256 members in turn on one machine took 1,421 s, longer than an epoch; that is the
  simulation's cost, not any member's.
- **Bytes grow as `n^2` per member**, because every dealer's log goes to every player point to
  point: 14.8 MB from the largest member at 256.
- **CPU**: experiment 10's runner shared the machine until 06:28, during the sizes up to 128,
  so their times may be high; 256 ran alone.

### 423 and 512 members (`member`)

One dealer and all `n` players' checks of its dealing, in memory, no network time.

| n | quorum | dealer: msgs sent | dealer: bytes sent, point to point | dealer: unique bytes | `32n + 48t` | dealer's own work | a player's check (median) | a player's checks of all `q` dealings (derived) |
|---|---|---|---|---|---|---|---|---|
| 423 | 283 | 846 | 40,398,192 | 109,008 | 20,256 | 97 ms | 20.2 ms | 5.7 s |
| 512 | 342 | 1,024 | 59,118,080 | 131,817 | 24,544 | 119 ms | 23.1 ms | 7.9 s |

`t` in `32n + 48t` is the faults tolerated, `n - q`: 140 and 170. A dealer's unique bytes are one
public message (27,170 and 32,834 bytes), one 32-byte private share for each player, and its log
(68,302 and 82,599 bytes); Commonware's log carries the public message and every player's
acknowledgement, 64 bytes each. So the unique bytes are about 5.4 times the post's figure at both
sizes, and point to point, with the log sent to every player, about 2,000 and 2,400 times. A
broadcast medium that carries each log once, such as the chain or a gossip layer, pays the unique
figure. The dealer's own work is its dealing, 71 and 87 ms, plus checking the acknowledgements
and finalizing. A player's finalization, which checks the `q` logs and interpolates its share, is
not measured. With that left out, a member at 512 does about 8 s of work in an epoch of 384.
