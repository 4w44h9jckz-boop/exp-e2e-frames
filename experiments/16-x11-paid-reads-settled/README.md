# Experiment 16 (X11): a read server paid for blind tickets, fairly, with one write a batch

**Status: pre-registered.** This README states the question, the design, the predictions and
what would show them wrong, and is pushed before any contract, runner or transaction.

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
