# Experiment 27 (X20): the messages a wallet must receive, with no operator in the path

**Status: pre-registered 2026-11-05,** before any code, contract, runner or transaction.
Predictions, what would show each wrong, and the deviations are fixed here. Results are added below
them, and nothing above the results is edited after a run.

## The question

A wallet has to receive things that are not transactions:
- a note's opening, without which a payment cannot be spent;
- a guardian's sealed recovery share, without which a lost device stays lost;
- a counterparty's key change, an access grant, or a shared document's latest checkpoint.

Private messaging and document services keep the content from their operator, and most of the
metadata. Each still has one operator that every message or live document passes through. That
operator cannot read what it carries, and it can refuse to carry it.

This experiment builds the path with no operator in it:
- a key directory on L1;
- sealed payloads carried in blobs, each announced so its recipient can find it;
- relaying and archiving as paid jobs that anyone can take.

It asks whether three kinds of message can be delivered that way:
- a note's opening;
- a recovery share;
- a document checkpoint.

Each is delivered first with every relay and every archiver but one removed, and then with none.
It asks what each costs, and who learns what. Live chat and co-editing are out of scope: they need
milliseconds, and they stay on relays.

## The design

- **The directory.** A contract maps a leanSPHINCS public key to that key's current ML-KEM-768 key.
  An entry is written only with a dependency signed by its own leanSPHINCS key, so no operator
  registers anyone. The directory stores the ML-KEM key's hash and logs the key itself.
- **The board.** One contract carries every announcement and pays every job:
  - **A sealed payload.** The sender encrypts the payload to the recipient's directory key, with
    ML-KEM-768 and AES-256-GCM, padded to one of a few fixed sizes.
  - **The announcement.** A pairwise tag after first contact, as experiment 18's setting 4 has it,
    or the recipient's ML-KEM ciphertext on first contact.
  - **Relays.** A relay packs several senders' payloads into one blob, and posts it with their
    announcements. Each sender's signed fee voucher pays the relay from that sender's deposit on
    the board, per byte.
  - **Self-posting.** A sender that every relay refuses posts its own payload, in a blob or in
    calldata. It pays from its own deposit, signed by its own key.
- **Archivers.** An archiver keeps blobs past their window and serves them, paid per retrieval from
  the recipient's deposit, by a voucher the recipient signs. A recipient fetches the whole blob,
  never one payload, so the archiver does not learn which payload was the recipient's.
- **Documents.** A document's key is sealed to each grantee's directory key and posted as a
  payload, which is the grant. Each checkpoint is a payload sealed with the document key and
  announced to every grantee. Revoking a grantee is a new document key, sealed to the others only.

Every transaction's sender is the board or the directory itself, approving in its own `VERIFY`, as
experiment 26's rollup is. So no account holds a key. Writers, senders and recipients appear only
as leanSPHINCS dependencies, and each pays from a deposit credited at genesis.

## Design

### The tools, pinned

- **The local chain:** ethrex `64b8fc09` with experiment 19's patch, as written, since every
  dependency here is a leanSPHINCS signature. Its program directory is experiment 19's.
- **leanVM** at `3cbac04`, through experiment 19's `prover/`, built with `-C target-cpu=native`.
- **ML-KEM-768 and AES-256-GCM** from `@noble/post-quantum` and Node's `crypto`, as experiment 26
  uses them.
- **No secp256k1 key** is set or used.

### The parties

- Two wallets, W1 and W2, each with a leanSPHINCS key and a directory entry.
- A guardian G, with its own entry, and a document owned by W2, whose grantees are W1 and G.
- Two relays, R1 and R2. R1 refuses W2's payloads throughout.
- Two archivers, A1 and A2. A1 goes offline after the first round.

### Arms

1. **The directory.** W1, W2 and G each write their entry. A write signed by another key is
   refused. W1 then rotates its key, and later messages to W1 use the new one.
2. **Delivery, with every relay and archiver but one removed.** Three messages are sent:
   - W2 sends W1 a note's opening;
   - G sends W1 a recovery share;
   - W2 sends a document checkpoint to its grantees.

   Relay R1 refuses W2's payloads, and R2 packs and posts them. Archiver A1 is gone when W1 and
   W2 fetch, and A2 serves them. Each recipient finds its payloads from the board's announcements
   alone and opens them.
3. **Delivery with none.** With both relays and both archivers gone, each sender posts its own
   payload in calldata, and each recipient reads it from L1 alone.
4. **The document.** W2 revokes a third grantee, G, by a new document key sealed to W1 alone. W1
   opens the next checkpoint, and G cannot.
5. **Who learns what.** For every party, the record lists what each input it received names: the
   relays, the archivers, a blob's reader, and the board's logs. The record checks that input
   against the table below.
6. **The local chain's blocks,** scanned for any secp256k1 or P-256 signature.

### Measures

- **Per message:** gas, as the payload's share of its blob, the announcement and the voucher;
  bytes; and blocks from sending to the recipient opening it.
- **Per job:** a relay's fee per byte, and an archiver's fee per retrieval, each set before the run
  and recorded.
- **Against the transaction each message enables:**
  - a note's opening, against experiment 18's spend, 216,580 gas in `VERIFY` alone;
  - a recovery share, against the recovery's own transactions in exp-frames experiment 49's arm 3,
    on experiment 22's chain;
  - a checkpoint, against nothing, recorded alone.

### Who may learn what

| Party | May learn | Must not learn |
|---|---|---|
| everyone reading L1 | which keys have entries, and when they rotate | who writes to whom |
| a relay | the sender who pays it, and the payload's size | the recipient, the content |
| a blob's reader | that a payload exists, and its size class | the recipient, the content |
| an archiver | which blob is fetched, and by whose voucher | the content; which payload in the blob |
| a recipient | the sender, from the payload | nothing it was not sent |

## Predictions

1. **The directory needs no operator.** Each entry is written by its own key's dependency alone,
   and a write signed by another key is refused. After a rotation, messages sealed to the old key
   are not opened with the new one, and later messages use the new one.
2. **One relay's refusal does not stop a message.** With R1 refusing, every payload of W2's is
   carried by R2. With both relays gone, every sender's own post is mined.
3. **The recipient needs only its key and L1, and one archiver for blob bytes.** With A1 gone,
   every recipient finds and opens every payload sent to it, from the board's logs and A2's blobs.
   With both archivers gone, every recipient opens the calldata posts from L1 alone.
4. **No carrier learns more than the table allows.** No input a relay or an archiver receives names a
   payload's recipient or holds its plaintext. An archiver's request names a whole blob, never a
   payload in it.
5. **A message costs less than ten times the transaction it enables.** The gas a note's opening
   costs in a packed blob, its share and its announcement together, is under ten times
   experiment 18's 216,580. The same holds for a recovery share against the recovery's own
   transactions.
6. **Revocation holds.** After the new document key, the revoked grantee opens no later
   checkpoint, and each remaining grantee opens every one.
7. **No classical signature.** No block of the runs carries a secp256k1 or P-256 signature.

## What would show it wrong

| # | Shown wrong if |
|---|---|
| 1 | a directory entry is written by a dependency of another key, or a message sealed to a rotated-out key opens with the new one |
| 2 | a message is not delivered while one relay refuses it, or a self-post is refused |
| 3 | a recipient misses or cannot open a payload sent to it, with A1 gone, or with both archivers gone for a calldata post |
| 4 | any relay's or archiver's input names a payload's recipient or holds a plaintext, or an archiver's request names one payload |
| 5 | a note's opening costs ten times experiment 18's 216,580 or more, or a recovery share ten times its recovery's transactions |
| 6 | the revoked grantee opens a later checkpoint, or a remaining grantee cannot |
| 7 | any block of the runs carries a secp256k1 or P-256 signature |

## Deviations, stated before the run

- **The local chain keeps no blob once mined,** as experiment 26 found: `engine_getBlobs` reads only
  ethrex's pool, its store keeps no sidecar, and no consensus client runs here. So "within the blob
  window" has no window here. A recipient reads every blob through an archiver from the start,
  and the archiver's job is what the record tests. A chain with a consensus client would serve
  blobs for about 18 days first (EIP-4844).
- **The archiver's possession is not challenged here.** Experiment 17 showed an archiver without a
  blob slashed by a point evaluation. That challenge is not repeated.
- **Fees are this experiment's choice:** a relay's per byte and an archiver's per retrieval, each
  stated before the run.
- **leanVM has no zero knowledge at its pin, and none is used here:** every dependency is a
  leanSPHINCS signature, and no privacy result rests on a proof.
- **Timing is the local chain's.** Its dev producer makes a block a second, so "blocks to deliver"
  is not a slot count on a public chain.

## Path

- `contracts/`: the directory and the board.
- `x20.ts`: sealing, tags and vouchers.
- `run.ts`: arms 1 to 6 on the local chain.
- `results/`: each run's record, with its commit, command and inputs.
