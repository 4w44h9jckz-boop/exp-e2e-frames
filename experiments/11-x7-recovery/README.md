# Experiment 11: every device lost, the wallet recovered, and a note spent through open nodes

**Status: written before any transaction.** This README states the claim, what would show it
wrong and the plan. The runner and the offline checks follow, and are pushed before the first
transaction.

**The claim.** A wallet whose every secret derives from one seed can be lost entirely and still
be spent from. What survives the loss is:
- shares of a recovery key, held by guardians who never hold the seed;
- a phrase the user keeps in mind;
- an encrypted backup that anyone may store;
- the chain.

From those alone, a fresh device rebuilds the seed, reopens the backup and spends what the lost
device could: a note in a privacy pool, a blind ticket and the account itself. The spends go
through open mempool nodes, with no relayer and nobody paying for the user.

**What would show it wrong.** Any one of these:
- a step after the loss needs a party other than the guardians, the user's phrase, an open node
  and the chain. The runner removes the funder's key from every step after the loss, so a
  step that needs it fails, and that failure is the finding;
- something the old device could spend, the pool note, the ticket or the account, cannot be
  spent from the new one;
- the seed the guardians and the phrase give back is not the seed that was lost, or the
  backup's reopening gives back another.

**What it does not test.** A stolen device, where the thief races the recovery, or guardians who
collude. Nor a lost phrase: without it, the guardians' shares alone do not open the seed, by the
construction the claim relies on.

## Pieces

| Piece | Role |
|---|---|
| kohaku-rs, `kohaku-frame-secrets`'s examples | `seed_wallet` builds the wallet from one seed and restores it on a fresh device; `guardians` splits a recovery key to guardians and recovers through them; `backup` writes the encrypted backup and reopens it |
| skandha | two nodes with frame transactions on. B alone hands transactions to the chain |
| chain | the ethrex Hegota testnet, chain 8141 |

Each is pinned at a full commit in `pins.json` when the runner lands.

## The plan

One fresh seed, made for this run and never recorded. The guardians' storage and the user's
phrase live in one state directory, as the examples model them, standing in for parties apart.

1. **The device, while it exists** (to the chain directly, the funder paying):
   - the wallet is built from the seed: its account, a pool note, a ticket;
   - the guardians are set up and the account committed to their recovery key;
   - the backup is written.
2. **The loss.** The seed file is deleted. The runner keeps only a digest of it in memory, to
   compare against what comes back, and never writes it down.
3. **After the loss,** with no funder key in any step's environment:
   - the guardians and the phrase recover the seed to a fresh device;
   - the backup is reopened from what the chain and the guardians hold;
   - the fresh device spends the pool note, the ticket and the account, each sent to node A.
4. **Two nodes,** A and B, peered with each other only, for the spends. B alone hands them to
   the chain.
5. **The record** keeps each example's own record, which holds no key, word, share or plaintext,
   and every spend's bytes, each node's log lines for it and whether it was mined. It keeps,
   for the seeds, only whether they are equal.
