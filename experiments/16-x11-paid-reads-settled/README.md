# Experiment 16 (X11): a read server paid for blind tickets, fairly, with one write a batch

**Status: run.** The question, the design, the predictions and what would show them wrong were
pushed at `4f2670d`, before any contract, runner or transaction; the pool, the parties and the
runner followed at `04ea014`. Run 1's results are below ("Results, run 1"): every prediction held.

exp-frames experiment 37 paid for private reads with blind tickets. A reader bought tickets in
public, a committee of issuers signed them blindly, and a read server checked a ticket before it
answered. Its README ends on what it left out: "How a server redeems spent tickets is not part of
this experiment." This experiment is that part. The question is how a service that never writes to
L1 gets paid for the tickets it took, without anyone being able to cheat the exchange:
- the server cannot be paid for a read it did not deliver;
- the reader cannot keep the answer and the ticket's value both;
- no ticket is paid twice.

All of this has to hold while L1 stores only a digest per batch and checks only signatures.

## The pieces

- **The ticket.** As exp-frames 37: a threshold BLS signature by the issuers, on the message
  $m = \mathrm{server} \parallel \mathrm{serial}$ under a namespace for read tickets, issued
  blindly. The reader picks the serial, blinds the hash of $m$, and unblinds the issuers' answer.
  So no issuer can match a ticket it signed to a serial it later sees. Here the issuers' key is
  dealt by one process and issuance runs in this repository's TypeScript on `@noble/curves`, since
  issuance is not what this experiment tests: experiment 04 and exp-frames 36 ran it from
  Commonware's DKG.
- **The pool.** One contract, `ReadPool`, that sells tickets at a fixed price, holds what it
  sold, and pays it out only against a quorum's signatures. It is the sender and payer of its own
  frame transactions, as experiment 15's registry was, so neither a server nor a reader needs
  ether to be paid.
- **The attesters.** Four members, each with an ECDSA key and a bond in the pool, quorum three.
  A member signs only what it saw itself. This is this experiment's own committee. The native path
  for the same job, the payload timeliness committee that EIP-7732 already samples and EIP-8184
  (LUCID) reuses for key reveals, is argued in the write-up and not run.
- **The service.** A stand-in read server: the reader sends a query and a ticket, and the server
  answers with a value it computes from the query, encrypted to a key the reader sent. A private
  read (PIR) ran in exp-frames 37. Here the answer's content is not what is tested, only whether
  it was delivered on time.

## The exchange

```text
reader                     server                         attesters (4, quorum 3)       L1 (ReadPool)
------                     ------                         -----------------------       -------------
buy tickets  ------------------------------------------------------------------------>  price each
blind serials -> issuers sign -> unblind
query, ticket, reader key -> check ticket, spent set
                           answer, encrypted to the reader
                           (serial, ticket, ciphertext) -> each member: ticket valid,
                                                           server named, serial new,
                                                           before the epoch's deadline?
                                                           keep the ciphertext
<--------------------------  ciphertext  (or from any member, if the server withholds it)
                           after the epoch:
                           batch (server, epoch, n, root
                           of the serials)   ------------>  each signs if it saw every
                                                           serial in time, and none of
                                                           them was paid or refunded
                           settle: 3 signatures ----------------------------------------->  VERIFY: quorum over the
                                                                                            digest; nonce key
                                                                                            H(server, epoch);
                                                                                            pay n x price
a serial never delivered:
refund request (serial, a fresh address) ----------------> each signs if it never saw
                                                           the serial delivered by the
                                                           deadline, and the ticket is valid
refund: 3 signatures ------------------------------------------------------------------>  VERIFY: quorum; nonce key
                                                                                            H(refund, serial); pay
                                                                                            the price, less gas
anyone holding two signatures of one member that conflict ------------------------------>  slash: the bond to the
                                                                                            reporter
```

**What L1 stores and checks.** Per server and epoch, one settlement: the count and the root of the
serials, three ECDSA signatures checked in `VERIFY`, and one nonce key. Per undelivered read, one
refund. Nothing else about a read reaches L1.

**Conflicts a member can be slashed for**, each provable from two of its own signatures:
1. the same serial in two settled batches: two batch digests and a Merkle proof of the serial in
   each root;
2. the same serial in a batch and in a refund: a batch digest, a proof of the serial in its root,
   and a refund digest.

A member that signs something false but not self-conflicting is not slashable. An example is a
batch with a serial that was never delivered to it. Against that, the protection is the quorum: it
takes three of the four.

## What is predicted, written before the run

1. **Settlement does not grow with the reads.** Batches of 1, 16 and 256 serials settle for gas
   that differs only by the encoding of the count: about the same.
2. **Settlement fits EIP-8141's public-mempool budget.** The settlement's `VERIFY` uses under
   100,000 execution gas, EIP-8141's `MAX_VERIFY_GAS`. Experiment 04's ticket check, at 122,006,
   and every proof check in experiments 05 to 15 did not fit it.
3. **Only a quorum pays, once.** A settlement with two signatures, with signatures over another
   server's batch, or for a server and epoch already settled is refused before inclusion.
4. **An undelivered read is not paid to the server and is refunded to the reader.** The server
   withholds one read from the attesters. The honest members refuse any batch that contains its
   serial. The reader's refund for it, signed by three members, is mined, and the price, less the
   refund's gas, reaches a fresh address.
5. **A delivered read cannot be withheld from the reader.** The server delivers one answer to the
   attesters but not to the reader. The reader gets the ciphertext from one member and decrypts
   the answer.
6. **A member's conflicting signatures cost it its bond.** One member, run dishonestly, signs a
   batch that repeats a serial already settled, and signs a refund of a serial already settled.
   Each pair is mined as a slash, and the bond goes to the reporter. A pair that does not conflict
   is refused.
7. **No serial is paid twice.** With one dishonest member and three honest ones, a batch
   repeating a settled serial and a refund of a settled serial each get at most two signatures.
   The settlement or refund sent with them is refused.
8. **What L1 learns.** Per settlement, a server, an epoch, a count and a root. Per refund, a
   serial and a fresh address. Per purchase, the buyer and the count, as before. No read's query or
   answer, and no link from a serial to a purchase.

## What would show it wrong

- Settlement gas grows with the batch.
- The settlement's `VERIFY` needs 100,000 execution gas or more.
- A settlement below quorum, for another server, or a second one for an epoch, is admitted.
- The server is paid for the withheld read, or the reader's refund for it fails.
- The reader cannot get a delivered answer from a member.
- A conflicting pair is not slashable, or a non-conflicting pair is.
- Any serial is paid twice: to the server twice, or to the server and the reader.
- Any read's query, answer or reader appears on L1.

## What is recorded with no prediction

- Gas by frame for every transaction; calldata bytes.
- The time a member takes to check a ticket, and a batch.
- The pool's balance before and after: what was sold, paid, refunded and slashed.
- The blocks between an epoch's end and its settlement.

## Deviations, stated in advance

| What a deployment would have | Here | Why |
|---|---|---|
| issuers from a DKG | a dealt key | issuance is experiments 04's and exp-frames 36's |
| a private read (PIR) | a stand-in answer, encrypted to the reader | the content is not tested; exp-frames 37 ran PIR |
| the payload timeliness committee | four bonded members of our own | the PTC votes on payloads, not on services; using it for this job is a protocol change, which the write-up argues as the native path |
| members on separate machines | four signers in the runner, each with its own state and its own checks | the protocol is what is tested, not the network |
| a clock from consensus | the chain's head block, as each member reads it | the test network's head is what a member can see |

## Results, run 1 (`results/1-first-run.json`)

Run on 2026-10-29 on the test network (ethrex `64b8fc09`, as the record's `client` says), at this
repository's `04ea014`, with skandha `ede942f`, as deployment `d1`, on its first pass. The pool
was `0xca06d48C...` (the transactions' sender; see "Harness faults" for why the record lacks the
field). Every settlement, refund and slash went to node A, which gossiped it to node B, which alone
handed it to the chain. The runner searched the record for every key, share, seed and blinding
factor before writing it. The 7 mined transactions and all 275 tickets are kept in
`test/fixtures/x11/1-first-run.json`, and `test/x11.test.ts` rebuilds each transaction, recovers
every signature to its member and checks every ticket against the issuers' key.

The set-up deployed the pool and, in one transaction, posted four bonds of 0.002 ether, bought 275
tickets at $10^{12}$ wei and sent a float of 0.01 ether. The issuers signed the 275 blinded points
in 14.9 s, each ticket by a different quorum of three in turn. The reads ran in epoch 20,085: all
274 deliveries reached the four attesters between blocks 602,550 and 602,559. A member checked a
ticket in 39 ms on average and 71 ms at most, on one machine.

| Step | Prediction | Outcome | Block | Gas |
|---|---|---|---|---|
| settle the batch of 1 | 1, 2 | mined | 602,581 | 442,224 |
| settle the batch of 16 | 1, 2 | mined | 602,582 | 344,304 |
| settle the batch of 256 | 1, 2 | mined | 602,583 | 344,280 |
| the batch of 16 again, byte for byte | 3 | refused at node A: `ErrNonceTooLow` | | |
| the batch of 1's signatures, under sd's address | 3 | refused at node A: `ErrFramePrefixReverted` | | |
| sd's batch with two of its signatures and a third over another batch | 3 | refused at node A: `ErrFramePrefixReverted` | | |
| sd's batch with the withheld read | 4 | never sent: the three honest members refused to sign it | | |
| sd's batch without it | 4 | mined | 602,584 | 344,316 |
| the withheld read refunded, an epoch after it was asked | 4 | mined; the reader's fresh address received 999,000,000,000 wei | 602,611 | 441,255 |
| a repeat of a settled serial, with the dishonest signature and two over another batch | 7 | refused at node A: `ErrFramePrefixReverted` | | |
| a refund of a settled serial, with the dishonest signature and two over its batch | 7 | refused at node A: `ErrFramePrefixReverted` | | |
| slash: two batches with no serial in common | 6 | refused at node A: `ErrFramePrefixReverted` | | |
| slash: one serial in two batches | 6 | mined | 602,612 | 376,838 |
| slash: the same pair again | 6 | refused at node A: `ErrNonceTooLow` | | |
| slash: one serial in a batch and a refund | 6 | mined | 602,613 | 168,662 |

**Against each prediction:**
1. **Settlement does not grow with the reads: held.** Batches of 16 and 256 settled for 344,304
   and 344,280 gas, and sd's batch of one for 344,316. Every settlement's frames used the same
   execution gas, 19,122 in `VERIFY` and 24,584 in `SENDER`; the differences are calldata. The
   first settlement, of the batch of 1, cost 97,920 more: it wrote the pool's `paid` counter for
   the first time.
2. **Settlement fits EIP-8141's public-mempool budget: held.** The settlement's `VERIFY` used
   19,122 execution gas, under a frame limit of 100,000; the refund's 18,955; a slash's 12,101 and
   12,660. Experiment 04's ticket check, at 122,006, and every proof check in experiments 05 to 15
   were over it.
3. **Only a quorum pays, once: held.** A second settlement of the same server and epoch was
   refused by its used nonce key. Signatures moved to another server's batch, and a set with one
   signature over another batch, were refused by the pool's `VERIFY`.
4. **An undelivered read is refunded to the reader, not paid to the server: held.** The three
   honest members refused sd's batch with the withheld read ("was never delivered to me"), and its
   batch without it settled. The reader asked for the refund at once; the honest members waited
   out the epoch, as the server's last chance, then signed. The refund paid $10^{12}$ wei less the
   fee of $10^{9}$.
5. **A delivered read cannot be withheld from the reader: held.** s1's server did not send its
   answer to the reader. The reader fetched the ciphertext from member 1 and decrypted the answer.
6. **A member's conflicting signatures cost it its bond: held.** Both slashes were mined, and the
   reporter's fresh address received $2 \times (10^{15} - 10^{9})$ wei. Member 3's bond went from
   0.002 ether to 0; the others' did not move. A pair with no serial in common was refused, and so
   was the same conflict sent twice.
7. **No serial is paid twice: held.** The honest members refused the repeat ("is already in a
   signed batch") and the refund of a settled serial ("it was delivered"). Both transactions, sent
   with the one dishonest signature and two over other digests, were refused at the node.
8. **What L1 learns: held.** None of the 275 queries, answers or ciphertexts, the reader's X25519
   key or the buyer's address appears in any of the 7 mined transactions (`onChain.found`, 0).
   A settlement carries a server, an epoch, a count, a root, a fee and three signatures, in 612
   bytes; a refund a serial and a fresh address, in 548.

**The pool, at the end:** 275 sold, 274 paid to servers, 1 refunded. It held
$1.8275 \times 10^{16}$ wei after the set-up and $1.6000006980 \times 10^{16}$ at the end: the 2
slashes paid out the bond, the gas came out of the float, and the fees covered the gas with a
little over.

**Findings:**
- **Paying for a service by digest fits validation's budget; paying by proof did not.** Three
  `ecrecover` calls and a hash cost the pool's `VERIFY` 19,122 gas, about a sixth of experiment
  04's single ticket check. The price is trust: the pool believes three of four members about
  delivery, where a proof would need no one.
- **The quorum did all the refusing that mattered off chain.** Every attempt to pay a serial twice
  died for want of a third honest signature. On chain, the pool only checks signatures; it never
  sees a serial except in a slash or a refund.
- **The refund's wait is the server's protection.** Members sign a refund only after a whole epoch
  from when they first hear of it, so a reader cannot race the server's delivery. A reader asks
  every member at once: each starts its own clock.
- **Equivocation is slashable here and is not in ePBS.** EIP-7732 says "There is no penalty for PTC
  nor payload equivocation". This pool slashes a member for its own two conflicting signatures,
  and only for those: a false but consistent signature is not slashable.

### Harness faults, not results

- **The record has no field for the pool's address.** `run.ts` set it, then spread its accounting
  object, also named `pool`, over it. The fixture script takes the address from the transactions,
  whose single sender it is, and `run.ts` now names the accounting object `accounts`.
- **A byte-for-byte resend.** "The batch of 16 again" is the same transaction as the first
  settlement, so node A's log for that hash holds the original's admission before the refusal.

### Transactions

| Step | Transaction |
|---|---|
| settle the batch of 1 | [`0x41a11485...`](https://dora.privacy.ethrex.xyz/tx/0x41a11485a367eb81b30b30e1e8e8d9da6b25c34fdffe905f34276218349b2f78) |
| settle the batch of 16 | [`0x0ad6d0ef...`](https://dora.privacy.ethrex.xyz/tx/0x0ad6d0eff1749015962f3416426f32f8195ede299f8c443aa2aeb3b595b4c552) |
| settle the batch of 256 | [`0x734f3558...`](https://dora.privacy.ethrex.xyz/tx/0x734f35583932069b63297cc43c4bafc1f7e1c6d02e2a2bd090dca6c98e6da5e0) |
| settle sd's batch without the withheld read | [`0x5324aee8...`](https://dora.privacy.ethrex.xyz/tx/0x5324aee820875367117f9594d1b8c01bd5ff85f41c6249fc6cf02e598ba38353) |
| the withheld read refunded | [`0x3bf002a4...`](https://dora.privacy.ethrex.xyz/tx/0x3bf002a41ba9ca7d37440ca08b56841e746234f17b5f9f9b8663c147a3fda60b) |
| slash: one serial in two batches | [`0x4e2d3d02...`](https://dora.privacy.ethrex.xyz/tx/0x4e2d3d020fd348d03d178dc3ecd7edb32bb110e7bcfd7a90e5197f26e7a97a3a) |
| slash: one serial in a batch and a refund | [`0x4ee5395d...`](https://dora.privacy.ethrex.xyz/tx/0x4ee5395dc3246db82fa552724b993f326b8890bfcc2ab63a75aa5dc105acd732) |

The test network's relaunches void these links; the fixtures keep the transactions.

