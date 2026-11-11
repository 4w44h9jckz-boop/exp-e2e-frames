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

All three parts ran on 2026-11-11 with no deviation.

### Part A: the spend input

**Files:** `SPEC-spend.md`, and `results/model.json`, which `model.py` builds from part B's
lifetimes.

| Input | Bytes per payout | Lifetime | Byte-hours | Links to |
|---|---|---|---|---|
| UTXO | 0.125 | forever | unbounded | its creation: source, value, recipient |
| Keyed nonce, today | 64 | forever | unbounded | the key: denomination, epoch, issuer |
| Ticket, one-day epochs | 64 | 6.0 h, mean | 384 | the key |
| Ticket, one-week epochs | 64 | 73.4 h, mean | 4,697 | the key |
| Ticket, four-week epochs | 64 | 324.7 h, mean | 20,779 | the key |

**Prediction 1 held, with one correction of wording.**
- The serial is one storage slot, which the model counts as a 32-byte key and a 32-byte value, 64
  bytes. That is 512 times a UTXO's spent bit, and it is freed when its epoch closes.
- The pre-registration called it "one 32-byte slot". The slot's key is the 32-byte serial.

**Prediction 2 held.** The frame names the key, which is the denomination, the epoch and the issuer
key, and nothing that names the purchase. A UTXO input names its creation by design. That is why a
ticket's spent fact cannot be a bit at an index: an index would name the purchase.

### Part B: epoch length against the timing linker

**Records:** `results/sweep.json`, and the output of `sweep.py`.

Linking success, single step and end to end, with the unconfined formula:

| Policy | $\lambda H$ | One day | One week | Four weeks | Unbounded | Formula |
|---|---|---|---|---|---|---|
| memoryless | 4 | 0.212 / 0.201 | 0.203 / 0.201 | 0.201 / 0.200 | 0.199 | 0.200 |
| memoryless | 16 | 0.057 / 0.057 | 0.060 / 0.059 | 0.059 / 0.059 | 0.060 | 0.059 |
| memoryless | 64 | 0.014 / 0.014 | 0.016 / 0.016 | 0.016 / 0.016 | 0.016 | 0.015 |
| uniform | 4 | 0.172 / 0.124 | 0.129 / 0.124 | 0.128 / 0.126 | 0.123 | 0.125 |
| uniform | 16 | 0.042 / 0.030 | 0.032 / 0.031 | 0.030 / 0.030 | 0.032 | 0.031 |
| uniform | 64 | 0.011 / 0.007 | 0.007 / 0.007 | 0.008 / 0.008 | 0.008 | 0.008 |

Serial state per key per epoch, at $\lambda H$ = 4, 16 and 64:

| Epoch | Serials | Mean lifetime | Holdings crossing a boundary | Trades among redemptions |
|---|---|---|---|---|
| one day | 8, 32 and 128 | 6 h | 64 to 75% | 50% |
| one week | 32, 128 and 511 | 73 h | 14% | 12% |
| four weeks | 117, 465 and 1,866 | 325 h | 3.5% | 3.5% |

**Against the predictions:**
1. **Held.** The unbounded column matches both formulas to within 0.005 in every cell.
2. **Held except in one cell.**
   - At $\lambda H$ = 4 with one-day epochs, the single step was 0.212 against 0.200, about 4.7
     standard errors.
   - In that cell nearly two holdings in three cross a boundary, so a payout's own purchase is most
     often a trade at the epoch's start, tied with the other trades of that instant.
   - The end-to-end figure, 0.201, is the formula's.
   - Elsewhere, memoryless single steps are within noise of the formula.
3. **Held.** Under uniform holding, one-day epochs raise single-step linking by about 40%: 0.172
   against 0.125. A payout early in an epoch has fewer candidates within $2H$. One-week epochs
   raise it slightly, and four-week epochs not at all.
4. **Held for uniform holding,** where the gap is 0.048 at one day, 0.005 at one week and 0.002 at
   four weeks. It widens as $L$ approaches $H$. Under memoryless holding the gap appears only at
   $\lambda H$ = 4, and at 16 and 64 it is within noise.
5. **Held.** Serials kept per epoch are about $\lambda L$ plus the trades.

**How it reads.**
- **End-to-end linking stays at the unconfined formula in every cell.** That is linking a payout to
  the buyer who started it, and it is the figure that matters for privacy.
- **Trades do not help the linker reach the buyer.** Tickets traded at the same instant are
  interchangeable to it, so the trades leave that figure where it was.
- **What an epoch length buys and costs:**
  - a shorter one keeps fewer serials, for less time;
  - it raises the single-step linking of a payout to the purchase under its own key, which is a
    trade, not a buyer;
  - it costs more trades: half of all redemptions at one-day epochs, against 3.5% at four weeks.
- **Each trade is a transaction,** a pairing and a serial (part C).

### Part C: the trade at epoch end

**Records:** `results/1-trade.json`. The client patch with `BLINDROLL` has sha256 prefix
`4d387b486275` and its binary `8ae723e8a80e`. The run used the client's default validation.

| Case | Outcome | Receipt gas | Counts after: old, then new (minted/burned) | Escrow after |
|---|---|---|---|---|
| setup: buy 2 under the old key | mined | 230,340 | 0/2, 0/0 | 2D |
| (g1) a trade of one ticket | mined | 202,442 | 1/2, 0/1 | 2D, unchanged |
| (g1) the new ticket paid under the new key | mined | 227,242 | 1/2, 1/1 | D |
| (g2) the old ticket again, as a payout | refused: serial spent | | unchanged | |
| (g2) the old ticket again, as a trade | refused: serial spent | | unchanged | |
| (g3) a trade to an earlier key | refused: "the new key's epoch is not later" | | unchanged | |
| (g4) a claimant the one-time key did not sign | refused | | unchanged | |
| (g5) setup: the second ticket traded | mined | 177,442 | 2/2, 1/2 | D |
| (g5) a trade with no purchase left | refused: the count | | unchanged | |
| (g6) the invariant | holds: the escrow is D, one unpaid purchase under the new key | | | |

- **The new key's issuer** saw the claimant in the trade's log, checked the claimant's signature
  on its request, and served one ticket. A second request from the same claimant was not served.
- **The charges** equal the schedule: 176,950 for the first trade, which created the old key's
  serial account, and 151,950 for the second.
- **A trade to another denomination cannot be expressed at all.** The new key inherits the old
  one's `D`. So that half of (g3) became a property of the encoding, not a case.

**Every prediction held:**
- the escrow's balance did not move at a trade;
- the charges equal the schedule;
- the new ticket's payout is a payout under the new key like any other.

**What it does not show,** as pre-registered: the claimant is on chain, so the new key's issuer
knows that this claimant traded under the old key. The blind signature, not the claimant, keeps
the new ticket's payout unlinkable to it.

### Beside the contract version

The contract version's case (h), the same trade on the test network (`exp-frames` experiment 59 at
`f051f49`), is quoted from its README and not yet rerun here:
- one frame transaction carries the payout and the purchase;
- 477,338 gas in all, of which 293,760 is state gas for a keyed nonce and two fresh slots;
- the fee comes from a surplus prepaid into the account, so the new purchase is a full `D`.

**Natively,** a trade's precompile charge is 151,950 once the old key's serial account exists. The
receipt adds the transaction's own gas, 25,492 in this run (177,442 in all).

**The difference is mostly state pricing again,** as in experiment 30: the native schedule prices
a new slot at the older rates.
