# Experiment 31: blind tickets by epoch, a UTXO-style spend, and a native trade at epoch end

**Status: pre-registered 2026-11-11,** before any code: the simulation, the model, the client
patch and the runner. Results are added below. Nothing above them is edited after a run; a change
of plan before a run is recorded as a deviation.

This experiment follows experiment 30, which built `BLINDMINT`, `BLINDTRANSFER` and `BLINDPRUNE`
as precompiles on the local chain. It has three parts.

## Part A: a ticket as an input to a UTXO-style spend

**The question.** "Native UTXOs on Ethereum" (ethresear.ch topic 25368) proposes a single
value-conserving EIP-8141 frame. It folds UTXO inputs, UTXO outputs, account flows and gas into one
transition, and the only state a spent UTXO leaves is one bit at its creation index.

Can a blind ticket be a third kind of input to that frame, and what state does it leave?

**What is written.** `SPEC-spend.md`, a specification and a state-accounting model, not a build.
- **The input** carries the key `chi`, the serial, the one-time key, and the one-time key's
  signature over the outputs. One BLS signature covers all ticket inputs under a key.
- **The outputs** are UTXOs to stealth addresses.
- **The spent fact is the serial,** kept in its epoch's set and deleted when the epoch closes. It
  cannot be a bit at a creation index, as for UTXOs: an index would name the purchase and link the
  payout to it.
- **The model,** `model.py`, gives per payout:
  - the state written, in bytes;
  - how long that state lasts, under each epoch length of Part B;
  - what an observer can link from the frame alone.

  It sets each against a UTXO input and against experiment 30's precompile, with the
  pruning that experiment found possible on a chain with block access lists: one named write for
  each serial.

**Predictions:**
1. A ticket input writes one 32-byte slot that lives until its epoch closes, against a UTXO's one
   bit, which never goes.
2. The observer learns the key, which is the denomination and the epoch, and the payout's time. It
   does not learn the purchase.

## Part B: epoch length against the timing linker

**The question.** A key covers one epoch, so a shorter epoch keeps fewer serials for less time.
What does it cost in linking? This part runs at three lengths at least: one day, one week and four
weeks.

**The linker** is the one-target maximum-likelihood linker.
- **The model:** purchases under a key form a Poisson process of rate $\lambda$, and each holder
  redeems after a holding time $Y$ drawn from a density $f$.
- **What it sees:** every purchase time and one redemption's time.
- **What it names:** the purchase that maximises the likelihood of that redemption, with ties
  broken uniformly.

Unconfined, its success is known:
- $1/(1 + \lambda H)$ for memoryless holding of mean $H$;
- $(1 - e^{-2 \lambda H})/(2 \lambda H)$ for holding uniform on $[0, 2H]$.

**Confinement.** A key's tickets must be spent by its epoch's end. A holder still holding at the
end trades the ticket, in one transaction, for one under the next key (Part C).
- So one holding of length $Y$ that crosses $k$ epoch boundaries is a chain: a purchase, $k$
  trades, and a payout.
- A trade's two halves are one transaction, so an observer joins them.
- For a trade at the end, the linker uses the survival function, the probability of still
  holding, in place of the density.

**The simulation,** `sweep.py`, standard library only, seed 20261111:
- policies: memoryless and uniform on $[0, 2H]$;
- $H$ = one day;
- $\lambda H \in \{4, 16, 64\}$;
- epoch length $L \in$ {one day, one week, four weeks, unbounded};
- a stationary run of 60 epochs, the first 10 discarded, with at least 20,000 final payouts per
  cell.

**Measures, per cell:**
- **single-step linking:** the share of payouts whose purchase under the same key is named
  correctly;
- **end-to-end linking:** the share whose original purchase is reached by naming every step of
  its chain correctly;
- **the share of holdings that cross a boundary;**
- **the serials kept per key per epoch,** each a 32-byte slot, and their mean lifetime until the
  epoch closes.

**Predictions, written before the run:**
1. **The unbounded column** reproduces the two formulas to within 0.005: 0.200, 0.059 and 0.015
   memoryless, and 0.125, 0.031 and 0.008 uniform, at $\lambda H$ = 4, 16 and 64.
2. **Memoryless, single step:** confinement does not change the linker's success on payouts made
   before the epoch's end. The youngest purchase is still its guess, and only purchases after the
   target's compete.
3. **Uniform, single step:** shorter epochs raise success, since a payout early in an epoch has
   fewer candidates within $2H$ before it.
4. **End-to-end success** is below single-step success wherever holdings cross boundaries, and the
   gap widens as $L$ approaches $H$. A trade at the end is one of many at the same instant.
5. **Serials kept per epoch** grow in proportion to $L$, about $\lambda L$ plus the trades.

**How it is read:** the record gives, for each $L$, the state kept against the linking. No single
length is declared best.

## Part C: the trade at epoch end, natively

**What is built.** A fourth precompile, `BLINDROLL`, added to experiment 30's client patch
(`scripts/ethrex-blind.patch`, extended, with the same separate binary).
- **The trade.** A holder spends tickets under key `chi` and buys as many under a later key
  `chi'` of the same denomination, in one call. Both keys' escrow is the one `ESCROW` account, so
  no ether moves.
- **Checks:**
  - the tickets, the serials and the count, exactly as `BLINDTRANSFER` checks them;
  - `chi'` names the same `D` and a later `end`;
  - each one-time key signs `chi'` and a `claimant` address in place of a recipient.
- **Effects:**
  - the serials are marked;
  - `minted[chi]` and `burned[chi']` each rise by $n$;
  - a log records `chi'` and each `claimant`.
- **The new ticket.** `chi'`'s issuer blind-signs one ticket for each `claimant` that proves
  control of its key, once each, as it would for a purchase. The new ticket stays blind.
- **Gas**, the schedule in experiment 30's style:
  - a base of 1,100;
  - the pairing, 102,900;
  - two counts, 10,000;
  - 36,950 per entry, which is `BLINDTRANSFER`'s 45,950 less the 9,000 payment;
  - 25,000 if `chi`'s serial account is new;
  - 1,000 for the log.

**Cases, on the local chain under the client's default validation:**
- **(g1)** a trade of one ticket from `chi` to `chi'`, then the new ticket's payout under `chi'`;
- **(g2)** the old ticket again, as a payout and as a trade: both refused;
- **(g3)** a trade to a key of another denomination, and to an earlier key: refused;
- **(g4)** a trade whose one-time key signed another `claimant`: refused;
- **(g5)** a trade when `chi` has no purchase left: refused;
- **(g6)** the escrow invariant after each.

**Predictions:**
- every case as listed;
- the escrow's balance unchanged by a trade;
- the trade's precompile charge equal to its schedule;
- a payout of the new ticket indistinguishable on chain from a payout of any ticket under `chi'`.

**What it does not show.** The claimant is visible on chain and asks the issuer for a ticket. So
the issuer learns that this claimant traded under `chi`. The new ticket's payout stays unlinkable
to it by the blind signature, not by the claimant.

## Limits

- **Part A** is a specification and a model, with nothing built.
- **Part B's linker** is the one-target linker. A linker that reads every redemption on the record
  does better, and is not run here.
- **Part B's rates** are a grid, not measured arrivals.
- **Part C** runs on the local chain only, with one issuer key, and its gas is a priced schedule.

## Files

- `SPEC-spend.md` and `model.py`: Part A.
- `sweep.py`: Part B.
- `run.ts`: Part C.
- `results/`: each part's output.

## Results

Not yet run.
