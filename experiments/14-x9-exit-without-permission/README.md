# Experiment 14: an exit that nobody's permission opens, for a committee that holds state

**Status: claim, what would show it wrong and the plan only.** This README is committed before
any code, contract or transaction. The construction is chosen next, by the committee's and the
wallet's builders, and committed before the first transaction, as in experiments 05 to 13.

**Why.** Experiment 07 ran a committee that holds users' notes in shares, with its proof checked
in its own `VERIFY` frame. Once that committee stopped, nothing moved the note it held. TACEO's
design for private payments has the same shape, and TACEO proposes an escape hatch for it, in
"Escape hatches in MPC, and who may open them" (core.taceo.io, 2026-08-03):
- on every transfer, the network publishes each new note's opening, encrypted to its owner;
- if the queue of intents stalls for a fixed time, the contract changes mode by itself;
- each user then redeems their own note alone.

This experiment builds that shape in frames and asks whether frames add what such an exit needs:
a redemption that no relayer and no committee member takes part in.

**The claim.** With frame transactions, a committee that holds users' notes can be made unable to
hold them hostage:
- **Normal mode.** Users queue intents on chain. The committee processes the head of the queue
  with an update, whose proof its account's `VERIFY` frame checks. With every update it also
  publishes the new note's opening on chain, encrypted to the note's owner.
- **The trigger.** If the head of the queue does not move for $T$ blocks, the contract enters
  escape mode on the next call, by itself. No signature, vote or admin takes part.
- **The escape.** Each owner decrypts its latest opening and redeems its own note with a proof
  made on its own device. The contract is the transaction's sender and payer, so neither a
  relayer nor any committee member takes part, and the owner needs no ether.
- **The return.** The committee may resume only after reconciling every redemption, and no
  update of its may spend a redeemed note.

**What would show it wrong.** Any one of these:
- escape mode needs anything besides time passing and the user's own transaction;
- a user cannot redeem without the committee, a relayer, or ether in an account linked to them;
- a redemption is accepted before $T$ blocks have passed with the queue stalled (amended below:
  "accepted" means "pays out");
- the same note is redeemed twice;
- after it resumes, an update of the committee is accepted that spends a redeemed note, or that
  skips reconciling;
- a published opening lets an observer tell which owner it is for, beyond what the redemption
  itself reveals. A redemption, like any withdrawal, reveals its amount and its recipient.

**Amended before any code, 2026-10-26, at the owner's word.** Two points found while the
builders chose the construction change the claim. Both are fixed here before any code reads an
opening and before any transaction.
- **An eighth condition.** With experiment 01's circuit, whoever knows a note's whole opening can
  redeem it. A committee that made the openings could then redeem every note to itself during
  escape, and an exit the operator can drain is not an exit. So this would also show the claim
  wrong:
  - anyone other than a note's owner, any committee member or all of them together included,
    redeems that note.

  The construction must make that impossible, and it can with the circuit unchanged. The
  circuit's commitment is a Pedersen hash of the nullifier $n$ and the secret $s$, a sum of
  terms over four-bit windows, and $s$ starts on a window boundary. So the commitment splits as
  $H(n \Vert s) = A(n) + B(s)$. The owner keeps $s$ and sends only the point $B(s)$, and each
  member chooses its own windows of $n$. No member knows $n$, nobody but the owner knows $s$, and
  only the owner can prove the redemption.
- **"Refused" before $T$ means "pays nothing".** A `VERIFY` frame may not read the block number
  or the time on this network, so the timeout can be checked only when the transaction executes.
  An early redemption may therefore be mined with its payout reverted. In plan step 3, and in the
  third condition above, "refused" and "accepted" are read as "pays nothing" and "pays out". The
  vault pays the gas of an early attempt, and how many attempts a note allows is recorded as a
  finding about frames.
- **Who sends an intent.** Only one proof fits a `VERIFY` frame, so each update processes one
  intent, and its published opening is tied to whoever sent that intent. The sixth condition
  therefore tests the owner's anonymity only if the owner never sends its own intent. In the run,
  a note's current holder sends the intent for its new owner. This is a choice of the plan, made
  by the coordinator before the run, not a change to the claim.

**Stated before the run, and not tested here:**
- **A garbage opening.** A committee could publish an opening that does not decrypt to the note,
  and the owner would learn it only on the day it needs it. TACEO answers this with a fraud proof
  that only the affected owner can make. Whether this experiment builds one is decided before the
  code and written here then. If it is not built, the record says so.
- **Who sends intents.** An intent here carries what the update needs and is not itself proved.
  TACEO's client proves its intent's well-formedness, and that proof is not tested here.
- **A malicious committee.** The committee is semi-honest, as in experiments 07 to 10. Stopping
  is the fault tested.

**Stand-ins, stated before the run.**
- TACEO's balance circuit is not used. The privacy pool's withdrawal circuit from experiment 01
  proves both the committee's update and the owner's redemption, as in experiment 07.
- $T$ is set small enough for the test network, and its value is written here before the run.

## Construction, chosen before the first transaction

Chosen by the committee's builders on 2026-10-26, agreed with the wallet's builders, and checked
by the coordinator against the conditions above before any code. Nothing below changes the claim
or the conditions.

### The vault

`contracts/ExitVault.yul` is experiment 30's `RefundPool` (exp-frames) with an intent queue, the
committee's update, published openings, escape mode and reconciliation added. `ExitVault.hex` is
its creation code from solc 0.8.37, EVM osaka, optimizer on at 200 runs, and `npm test` compiles
it again. The vault is the sender of three kinds of frame transaction, which its `VERIFY` tells
apart by their layout:

| Transaction | Frames | Nonce key | Who pays |
|---|---|---|---|
| redemption | `0x8272` root check; `VERIFY` vault, execution and payment; `SENDER` `withdraw`; `DEFAULT` refund | the note's nullifier hash, sequence 0, 1 or 2 | the vault, out of the note's fee |
| update | `VERIFY` vault, execution; `VERIFY` payer, payment; `SENDER` `process` | the spent note's nullifier hash, sequence 0 | the committee's payer |
| reconcile | `VERIFY` vault, execution; `VERIFY` payer, payment; `SENDER` `reconcile` | `keccak256("X9_RECONCILE" \Vert escapeAt)`, any sequence | the committee's payer |

The redemption is the refund pool's withdrawal byte for byte, so the owner's side reuses
kohaku-rs's refund-pool withdrawal with two changes: the withdraw frame's state budget is raised
to cover the vault's writes (below), and the nonce sequence is a parameter. Intents are ordinary
calls, `enqueue(bytes)`, by anyone. Every note the vault inserts, a deposit or an update's output,
emits the refund pool's `Deposit` event, so a wallet rebuilds the tree as it does for that pool.

### The timeout: $T = 30$ blocks, checked when the redemption executes

The chain made a block every 6.1 s over the 500 blocks before 2026-10-26 07:20 UTC, so $T$ is
about three minutes. EIP-8272 keeps a root usable for 8191 slots, so roots filed before the stall
stay usable through it.

A `VERIFY` frame cannot evaluate the timeout. At the testnet's commit (ethrex `64b8fc09`), the
mempool's validation trace bans `NUMBER`, `SLOTNUM`, and `TIMESTAMP` outside the expiry verifier,
and the expiry verifier sets the latest block a transaction may be included in, not the
earliest. So the vault's `VERIFY` accepts a redemption in escape mode, or in normal mode while
the queue is not empty, and `withdraw` decides: in normal mode it enters escape mode if the head
has not moved for $T$ blocks, and reverts otherwise. This is the amendment's reading of
"refused" as "pays nothing", and its consequences are recorded:
- an early redemption is mined, pays nothing, and uses one of the note's nonce sequences;
- the vault pays its gas, out of a float it is given at deployment (0.01 ETH in the rehearsal),
  not out of the notes it holds;
- each note allows three sequences, 0 to 2, so an owner can make the vault pay for at most two
  failed attempts and still redeem, and nobody else can make it pay at all, since a redemption
  needs a valid proof of a note;
- with the queue empty, a redemption is refused at the node, because the vault's `VERIFY` reads
  its own storage, which a sender's `VERIFY` may.

### Escape lasts at least $E = 30$ blocks

At the coordinator's request, `reconcile` reverts in its `SENDER` frame until escape mode has
lasted $E$ blocks, so a committee cannot close the hatch the block after it opens. Its nonce key
names the escape and accepts any sequence: an attempt mined too early reverts, and must not use up
the committee's only way back. (The rehearsal found this: with sequence 0 only, an early attempt
locked the committee out for good.)

### Reconciliation needs the whole committee

`reconcile` carries every redemption so far, strictly ascending, each spent and as many as the
vault counted, and the committee's threshold BLS signature on

$$m = \mathrm{chainId} \Vert \mathrm{vault} \Vert \mathrm{escapeAt} \Vert \mathrm{keccak256}(\mathrm{list})$$

under Commonware's `MinSig` with the namespace `X9_RECONCILE_V1`, checked on EIP-2537 as in
experiment 10. The key is 3-of-3, made by Commonware's DKG through `committee/bls-committee`, and
its G2 encoding is in the vault's code. Without such an authority anyone could reconcile and
restart the timeout while the committee stays stopped, which would show the claim wrong. Escape
mode refuses every update at the node until a reconciliation is mined.

### Notes, intents and openings

The withdrawal circuit's commitment is circomlib's Pedersen hash of the nullifier $n$ and the
secret $s$, 31 bytes each, a sum of terms over four-bit windows. With $A(x) = H(x \Vert 0)$ and
$B(s) = H(0 \Vert s) - H(0 \Vert 0)$,

$$H(n \Vert s) = A(n_0) + A(n_1) + A(n_2) - 2 H(0 \Vert 0) + B(s)$$

where member $j$ chooses $n_j$, the bits of $n$ in its own windows and zero elsewhere, and $n$ is
their bitwise OR:

| Member | Windows of $n$ | Bits |
|---|---|---|
| 0 | 0 to 20 | 0 to 83 |
| 1 | 21 to 41 | 84 to 167 |
| 2 | 42 to 61 | 168 to 247 |

- **The intent** carries, sealed to the committee's key, the new owner's opening key $P$ (33
  bytes, compressed secp256k1) and the point $B(s)$ (32 bytes, packed). The owner keeps $s$; $P$
  never appears on chain. A note's current holder sends the intent, never its owner (the plan's
  choice above).
- **Each member** sends the others only the point $A(n_j)$, and seals $n_j$ only to $P$. The
  update's submitter computes the commitment $C$ from the three points and $B(s)$.
- **No one but the owner can redeem.** No member learns $n$, and nobody but the owner learns $s$.
  This holds because $s$ never leaves the owner's device, not because the circuit binds a note to
  an owner's key, as TACEO's commitment does; with this circuit, whoever knows $n$ and $s$ can
  redeem.

Both kinds of message are sealed with exp-frames experiment 33's announcement scheme, with
version `0x02`, an info string and an AAD of the vault's address and a 64-bit number:

| Message | Info | AAD number | Plaintext | Sealed |
|---|---|---|---|---|
| intent | `x9/intent` | the intent's index | $P$ (33) and $B(s)$ (32) | 116 bytes |
| opening | `x9/opening` | the update's number, the intent's index | $n_j$ (31), member (1), leaf (4), update number (8), 4 zero bytes | 99 bytes, three per update |

The scheme is key-private: each message has a fresh ephemeral key, every message of a kind has
the same length, and neither carries $P$ or anything derived from it but a one-byte view tag that
only the holder of $P$'s secret can recompute. An owner tries every opening and keeps those that
open. One proof fits a `VERIFY` frame, so each update processes one intent: the record states the
batch size, 1, and that an opening is tied to its intent's transaction and so to its sender, the
note's previous holder, but not to its owner.

### The update's proof

The holder shares its old note's witness with the recipient set to zero. Each member then sets
the recipient over its share to

$$r = \mathrm{uint160}(\mathrm{keccak256}(\mathrm{vault} \Vert \mathrm{keccak256}(\mathrm{intent}) \Vert C \Vert \mathrm{keccak256}(\mathrm{openings})))$$

The recipient changes only two values of the circuit's witness, its public input and its square,
a private wire that each member can set as a trivial share of a public value
(`co_withdraw::set_recipient`, checked in `co-withdraw`'s tests). So the proof is bound to the
head intent, to $C$ and to the openings published with it, and nobody can replay it with other
openings.

### What the members hold, together

`exit-committee steal` pools everything the three members hold for an owner's note: every part
of $n$, $B(s)$, the owner's key, every sealing key and BLS share. It reports whether any witness
exists for a guess at $s$, and gives the runner the note's public inputs with a zero proof to send
to node A. Before the run, in memory, no witness exists: the circuit needs $s$, the members hold
only $B(s)$, and recovering $s$ from it is a discrete logarithm over 248-bit inputs.

### Not built: a fraud proof for a garbage opening

An owner learns that its opening is garbage only when it checks. In plan step 2 each owner
checks, and a check means: exactly one opening for each member, each part inside its member's
windows, leaf and update number as the event says, and $C$ rebuilt from the parts and $B(s)$.
TACEO's answer, a fraud proof only the affected owner can make, is not built here.

### Costs known before the run (derived)

- **A redemption's state gas.** `withdraw` may create the recipient's account (183,600 state
  gas), writes the note's spent slot (97,920), and on the first redemption the packed slot
  holding mode, escape block and count (97,920). The withdraw frame's state budget is therefore
  $183{,}600 + 2 \times 97{,}920 = 379{,}440$, against the refund pool's 183,600; the fee must
  cover the larger maximum cost, and the refund frame returns what is unused.
- **An update's prefix** is one Groth16 check in the vault's `VERIFY` and the payer's frame,
  against the nodes' 500,000.

### Runner hooks and checks

| Piece | What it gives the runner |
|---|---|
| `committee/exit-committee` | `keys`, `initcode`, `open-intent`, `part`, `commit`, `seal`, `recipient`, `update-data`, `reconcile`, `steal`, `vectors`; secrets stay in each member's directory, and only public values are printed |
| `committee/co-withdraw` | `member --recipient`: a member proves for the recipient above |
| `rust/` (`x9-runner`) | `update_tx`, `reconcile_tx` and `redemption_tx`; `send-update` and `send-reconcile`, which build, sign with `PAYER_KEY`, simulate on `RPC_URL`, send to `SEND_RPC_URL` and print the outcome; and `x9-runner local`, a rehearsal of plan steps 2 to 6 against a local ethrex node at the testnet's commit |
| `src/e2e/x9.ts` | the vault's selectors, topics and layouts, the sealing, the recipient, the reconcile message and nonce key, in TypeScript |
| `test/x9.test.ts` | the vault compiled again; every selector and topic it hard-codes; the committee's Rust vectors (`test/fixtures/x9/vectors.json`) opened and recomputed in TypeScript |

### Rehearsed on a local node before the first transaction

`x9-runner local` ran plan steps 2 to 6 against a local ethrex node built at the testnet's commit
(`64b8fc09`), with the committee in memory and $T = E = 30$ at a 500 ms block time
(`rehearsal/local-1.json`). These are not the run's results: one node, no skandha, no testnet.
They show the construction does what the plan needs, and they found one defect, fixed before
this commit: a reconcile mined before the escape window ended used up its nonce key's only
sequence, which would have locked the committee out for good.

| Step | Outcome | Gas by frame (execution / state) |
|---|---|---|
| two updates with openings | mined; each owner opened its openings and found its note at the leaf | vault `VERIFY` 257,758; payer 3,000 / 97,920; `process` about 1,030,000 / 293,760 to 391,680 |
| a redemption before $T$ blocks | mined; `withdraw` reverted; nothing paid | `VERIFY` 253,320 / 97,920; `withdraw` 2,898 |
| the members, together, for owner 0's note | no witness; their redemption without a proof refused at the node | |
| owner 0 (sequence 1), owner 1 (sequence 0) | mined, the vault sender and payer, each recipient paid the denomination less its gas; escape mode entered | `withdraw` 40,119 / 379,440 and 36,398 / 281,520 |
| owner 0 again (sequence 2) | refused at the node | |
| an update in escape mode; an update over a redeemed note | both refused at the node, the second by its nonce key, which the redemption used | |
| a reconcile before $E$ blocks | mined; `reconcile` reverted | `VERIFY` 126,738 |
| the reconcile | mined; normal mode | `reconcile` 24,324 |
| the update over the redeemed note, again; the queue | refused; then mined | |

## Pieces

| Piece | Built by | Role |
|---|---|---|
| the vault contract | the committee's builders | intents, updates, published openings, the timeout, escape mode, redemption and reconciliation |
| the committee's side | the committee's builders | an update proved over shares, with the opening it publishes |
| the wallet's side | the wallet's builders | an owner's key for openings; decrypt, prove the redemption on the device, and send it |
| the runner | the coordinator | the run through two skandha nodes on the Hegota test network, and the record |

## The plan

1. **Two nodes,** A and B, peered with each other only. Every transaction is sent to node A,
   except deployments and deposits, which go to the chain directly.
2. **Normal mode.** Two intents are queued, each sent by a note's current holder for its new
   owner, never by the owner. The committee processes both, and each update publishes an
   opening. Each owner checks that its opening decrypts to its note.
3. **Too early.** With the queue stalled for fewer than $T$ blocks, a redemption is sent. It must
   pay nothing (amended above).
4. **The committee stops.** Its members' processes end. One more intent is queued, and the head
   of the queue stays put for $T$ blocks.
5. **The escape.** Each owner redeems its own note through node A, with the vault as sender and
   payer. A second redemption of the same note is sent too, and must be refused.
   Before the owners redeem, the committee's members, together, try to redeem an owner's note
   with everything they hold. They must fail (amended above).
6. **The return.** The committee restarts and sends an update that spends a redeemed note, which
   must be refused. Then it reconciles, and then it processes the queue again.
7. **The record.** For every transaction it keeps:
   - its bytes and hash;
   - each node's log lines for it;
   - whether it was mined, and if so its block, status, payer and gas by frame;
   - the vault's mode before and after.

   It keeps no key, share, note secret or decrypted opening.

## Done when

On the test network, through two nodes, the run shows each of these:
- updates with published openings are mined;
- an early redemption pays nothing;
- the committee's members, together, cannot redeem an owner's note;
- after $T$ blocks, each owner's own redemption is mined with the vault as sender and payer;
- a second redemption is refused;
- the resumed committee's update over a redeemed note is refused, and its reconciliation is
  mined.
