# Experiment 11: every device lost, the wallet recovered, and a note spent through open nodes

**Status: run.** The claim, what would show it wrong and the plan below were committed before
any transaction (a780366), and the runner and its checks before the first (462b6ff). The results
are at the end. None of the three conditions that would show the claim wrong occurred in run 1.

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

## Runs

| Run | When (UTC) | Outcome |
|---|---|---|
| 1 | 2026-10-21, 09:02 to 09:12 | Recorded: `results/1-first-run.json` |

## Results, run 1

The six steps ran in their authors' order and each succeeded, 616 s in all. Only the first two
had the funder's key; the backup was written without it, and so was every step after the loss.
Every transaction was handled by the client `ethrex/v23.0.0-hegota-testnet-hotfix-64b8fc09`.

| Step | Funder's key | Time |
|---|---|---|
| build: the account, a pool note, tickets | yes | 86 s |
| setup: three guardian sets; the account committed to the first, then rotated to the second | yes | 216 s |
| write: two backup versions posted | no | 53 s |
| *the seed file deleted* | | |
| recover: two guardians and the phrase, to a fresh device | no | 192 s |
| reopen: the backup, from the chain and the recovered seed | no | 14 s |
| restore: the three spends, through node A | no | 55 s |

**Before the loss.** In setup, the funder paid nine guardians' gas. Guardians 2 and 3 started
a recovery to their own key, and the owner cancelled it inside the delay. Their finish, sent
after the delay, was refused in simulation (`validation prefix frame reverted`). After the
owner rotated to the second set, the first set's start was refused the same way. Each
backup version was posted in a 485,521-gas transaction (blocks 495,213 and 495,215).

**After the loss, to the chain directly.**

| Transaction | Paid by | Block | Gas |
|---|---|---|---|
| guardian 4 posts its share, sealed to the new device | guardian 4 | 495,217 | 32,646 |
| guardian 6 posts its share, sealed to the new device | guardian 6 | 495,219 | 32,646 |
| the second set starts a recovery to owner 1 | the account | 495,221 | 33,924 |
| owner 1 finishes, after the delay | the account | 495,241 | 42,604 |
| owner 1 rotates to the third set | the account | 495,243 | 32,447 |
| the envelope under the third set and the phrase, from a fresh sender | a rebuilt ticket | 495,245 | 336,772 |

The guardians paid from balances the funder gave them in setup, before the loss. No step after
it had the funder's key.

**The seeds.** The seed the guardians and the phrase gave back equals the lost one, and so does
the seed the reopened backup gives back. The record holds only these two comparisons.

**The spends, each sent to node A.** Every one reached B by gossip, left through B alone, and
was mined with every frame succeeding.

| Spend | Sender | Paid by | Block | Gas |
|---|---|---|---|---|
| the rebuilt pool note, withdrawn | the pool | the pool | 495,254 | 567,821 |
| a rebuilt ticket, spent | a fresh sender | the ticket's paymaster | 495,256 | 331,198 |
| the account, signed by its owner | the account | the account | 495,258 | 27,782 |

**What else the record shows.** The first guardian set, with the phrase, still opened the
envelope it had been given before both rotations: that envelope stays on the board, and the
recover step opened it (`oldEnvelope.openedBySet0WithThePhrase`). The reopen step's own table
lists what each leak opens, and says the same of an old set and the phrase. Rotating guardians
does not retire an old set that kept its shares and learns the phrase. In setup the same set
could not open that envelope without the phrase, nor with one wrong guess; the run does not
measure how hard the phrase is to guess. This is not one of the three conditions above.

**Checks.** `npx vitest run test/x11.test.ts`: 6 of 6 pass on run 1's record.

**What this does not show.** One run, with two nodes on one machine over loopback. Guardians,
the phrase and the device lived in one state directory, standing in for parties apart. As
written above, it does not test a stolen device, colluding guardians or a lost phrase.
