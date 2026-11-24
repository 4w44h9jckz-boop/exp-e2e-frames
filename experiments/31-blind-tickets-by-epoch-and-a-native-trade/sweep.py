#!/usr/bin/env python3
"""Experiment 31, part B: epoch length against the one-target timing linker.

Usage: python3 experiments/31-blind-tickets-by-epoch-and-a-native-trade/sweep.py [out.json]

Purchases under a key form a Poisson process of rate lam; each holder redeems after a holding
time Y drawn from a policy (memoryless with mean H, or uniform on [0, 2H]). Keys are per epoch of
length L. A holding that crosses an epoch's end is carried by a trade at that instant: the ticket
is redeemed under the old key and a purchase is made under the next key, in one transaction, so an
observer joins the two halves. A payout is the holding's final redemption.

The linker sees every purchase time under a key and one redemption's time, and names the purchase
that maximises the redemption's likelihood: the holding density f(t - u) for a payout at t, the
survival S(end - u) for a trade at its key's end. Ties are broken uniformly. Single-step success
names the payout's own purchase under its key; end-to-end success follows trades back, naming each
step, to the original purchase. Standard library only; seed 20261111.
"""
from __future__ import annotations

import bisect
import json
import math
import random
import sys

SEED = 20261111
H = 24.0  # hours
LAMBDA_H = [4, 16, 64]
EPOCHS_H = {"one day": 24.0, "one week": 168.0, "four weeks": 672.0, "unbounded": math.inf}
MIN_PAYOUTS = 20_000
WARM_EPOCHS = 10


def holding(rng: random.Random, policy: str) -> float:
    return rng.expovariate(1 / H) if policy == "memoryless" else rng.uniform(0, 2 * H)


def theory(policy: str, lh: float) -> float:
    if policy == "memoryless":
        return 1 / (1 + lh)
    x = 2 * lh
    return (1 - math.exp(-x)) / x


def run_cell(policy: str, lh: float, epoch: float, rng: random.Random) -> dict:
    lam = lh / H
    unbounded = math.isinf(epoch)
    if unbounded:
        warm = 20 * H
        horizon = warm + (MIN_PAYOUTS * 1.2) / lam + 20 * H
        n_epochs = 1
        length = horizon
    else:
        per_epoch = lam * epoch
        n_epochs = max(60, WARM_EPOCHS + math.ceil(MIN_PAYOUTS * 1.3 / per_epoch))
        length = epoch
        horizon = n_epochs * epoch
        warm = WARM_EPOCHS * epoch

    # Fresh purchases and their holdings.
    t, fresh = 0.0, []
    while True:
        t += rng.expovariate(lam)
        if t >= horizon:
            break
        fresh.append((t, holding(rng, policy)))

    # Purchase events per key: (time, id). Redemption events per key: (time, kind, id).
    # An id is an event index; trades link a redemption under key e to a purchase under e+1.
    purchases: dict[int, list[tuple[float, int]]] = {}
    purchase_info: dict[int, dict] = {}
    redemptions: list[dict] = []
    next_id = 0

    def epoch_of(x: float) -> int:
        return 0 if unbounded else int(x // length)

    payouts = []
    for s, y in fresh:
        end_t = s + y
        pid = next_id
        next_id += 1
        e = epoch_of(s)
        purchases.setdefault(e, []).append((s, pid))
        purchase_info[pid] = {"time": s, "key": e, "fresh": True, "origin": pid, "prev_trade": None}
        cur_pid, cur_e, origin = pid, e, pid
        crossed = 0
        if not unbounded:
            while (cur_e + 1) * length <= end_t:
                boundary = (cur_e + 1) * length
                if boundary >= horizon:
                    break
                trade = {"time": boundary, "key": cur_e, "kind": "trade", "true": cur_pid}
                redemptions.append(trade)
                tid = next_id
                next_id += 1
                purchases.setdefault(cur_e + 1, []).append((boundary, tid))
                purchase_info[tid] = {"time": boundary, "key": cur_e + 1, "fresh": False,
                                      "origin": origin, "prev_trade": trade}
                cur_pid, cur_e = tid, cur_e + 1
                crossed += 1
        if end_t < horizon:
            pay = {"time": end_t, "key": cur_e, "kind": "payout", "true": cur_pid,
                   "origin": origin, "crossed": crossed, "fresh_time": s}
            redemptions.append(pay)
            payouts.append(pay)

    sorted_times = {e: sorted(v) for e, v in purchases.items()}
    times_only = {e: [x[0] for x in v] for e, v in sorted_times.items()}

    def name(red: dict) -> int:
        """The linker's named purchase id for one redemption."""
        e = red["key"]
        lst, ts = sorted_times.get(e, []), times_only.get(e, [])
        t = red["time"]
        hi = bisect.bisect_right(ts, t)
        if hi == 0:
            return -1
        if red["kind"] == "payout" and policy == "uniform":
            lo = bisect.bisect_left(ts, t - 2 * H)
            cands = lst[lo:hi]
            return rng.choice(cands)[1] if cands else -1
        # Memoryless density, and every survival, decrease in age: the youngest purchase wins.
        youngest = ts[hi - 1]
        lo = bisect.bisect_left(ts, youngest)
        return rng.choice(lst[lo:hi])[1]

    counted = [p for p in payouts if p["fresh_time"] >= warm and (unbounded or p["time"] < horizon - length)]
    single = end2end = crossed = 0
    for p in counted:
        named = name(p)
        if named == p["true"]:
            single += 1
        # End to end: follow trades back from the named purchase.
        cur = named
        ok = True
        while cur >= 0 and not purchase_info[cur]["fresh"]:
            trade = purchase_info[cur]["prev_trade"]
            cur = name(trade)
        if cur < 0 or cur != p["origin"]:
            ok = False
        if ok:
            end2end += 1
        if p["crossed"] > 0:
            crossed += 1
    n = len(counted)

    # Serial state: one 32-byte slot per redemption under a key, kept until the key's epoch ends.
    if unbounded:
        serials = {"per_key_per_epoch": None, "mean_lifetime_hours": None,
                   "note": "one key forever: the set only grows, at lam per hour"}
    else:
        per_key: dict[int, int] = {}
        life = []
        for r in redemptions:
            e = r["key"]
            if WARM_EPOCHS <= e < n_epochs - 1:
                per_key[e] = per_key.get(e, 0) + 1
                life.append((e + 1) * length - r["time"])
        vals = list(per_key.values())
        serials = {"per_key_per_epoch": round(sum(vals) / len(vals), 2) if vals else 0,
                   "bytes_per_key_per_epoch": round(32 * sum(vals) / len(vals), 1) if vals else 0,
                   "mean_lifetime_hours": round(sum(life) / len(life), 2) if life else 0,
                   "trades_share_of_redemptions": round(
                       sum(1 for r in redemptions if r["kind"] == "trade" and WARM_EPOCHS <= r["key"] < n_epochs - 1)
                       / max(1, len(life)), 4)}
    return {"policy": policy, "lambda_H": lh, "epoch_hours": None if unbounded else length,
            "payouts": n, "single_step": round(single / n, 4), "end_to_end": round(end2end / n, 4),
            "crossed_share": round(crossed / n, 4), "unconfined_formula": round(theory(policy, lh), 4),
            "serials": serials}


def main() -> None:
    cells = []
    for policy in ["memoryless", "uniform"]:
        for lh in LAMBDA_H:
            for label, epoch in EPOCHS_H.items():
                rng = random.Random(f"{SEED}/{policy}/{lh}/{label}")
                c = run_cell(policy, lh, epoch, rng)
                c["epoch"] = label
                cells.append(c)
                print(f"{policy:10s} lH={lh:<3d} {label:11s} payouts={c['payouts']:6d} "
                      f"single={c['single_step']:.4f} e2e={c['end_to_end']:.4f} "
                      f"crossed={c['crossed_share']:.3f} formula={c['unconfined_formula']:.4f} "
                      f"serials/epoch={c['serials'].get('per_key_per_epoch')}", flush=True)
    out = {"seed": SEED, "H_hours": H, "lambda_H": LAMBDA_H, "epochs_hours": {k: (None if math.isinf(v) else v) for k, v in EPOCHS_H.items()},
           "min_payouts": MIN_PAYOUTS, "warm_epochs": WARM_EPOCHS, "cells": cells}
    path = sys.argv[1] if len(sys.argv) > 1 else None
    if path:
        with open(path, "w") as f:
            f.write(json.dumps(out, indent=1) + "\n")
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
