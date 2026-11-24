#!/usr/bin/env python3
"""Experiment 31, part A: the state a payout leaves, by input kind and epoch length.

Usage: python3 experiments/31-blind-tickets-by-epoch-and-a-native-trade/model.py [sweep.json] [out.json]

Bytes per payout:
- a UTXO input's spent bit: 1/8 byte, kept forever;
- a blind ticket's serial: one storage slot, a 32-byte key and a 32-byte value, kept until its
  epoch closes;
- today's keyed nonce (EIP-8250): one slot, kept forever.

Lifetimes for the ticket come from part B's sweep (the mean time from a redemption to its epoch's
end), at each epoch length; byte-hours multiply the two. Standard library only.
"""
from __future__ import annotations

import json
import sys

SLOT = 64.0  # a 32-byte key and a 32-byte value
UTXO_BIT = 1 / 8


def main() -> None:
    sweep_path = sys.argv[1] if len(sys.argv) > 1 else None
    out_path = sys.argv[2] if len(sys.argv) > 2 else None
    lifetimes: dict[str, list[float]] = {}
    if sweep_path:
        sweep = json.load(open(sweep_path))
        for c in sweep["cells"]:
            if c["epoch_hours"]:
                lifetimes.setdefault(c["epoch"], []).append(c["serials"]["mean_lifetime_hours"])
    rows = [
        {"input": "UTXO", "bytes": UTXO_BIT, "lifetime_hours": None, "byte_hours": None,
         "links": "its creation: source, value, recipient"},
        {"input": "keyed nonce (today)", "bytes": SLOT, "lifetime_hours": None, "byte_hours": None,
         "links": "the key: denomination, epoch, issuer"},
    ]
    for epoch, lives in lifetimes.items():
        mean = sum(lives) / len(lives)
        rows.append({"input": f"blind ticket, {epoch} epochs", "bytes": SLOT,
                     "lifetime_hours": round(mean, 1), "byte_hours": round(SLOT * mean, 1),
                     "links": "the key: denomination, epoch, issuer"})
    print("| Input | Bytes per payout | Lifetime | Byte-hours | Links to |")
    print("|---|---|---|---|---|")
    for r in rows:
        life = "forever" if r["lifetime_hours"] is None else f"{r['lifetime_hours']} h, mean"
        bh = "unbounded" if r["byte_hours"] is None else f"{r['byte_hours']:,}"
        print(f"| {r['input']} | {r['bytes']} | {life} | {bh} | {r['links']} |")
    print(f"\nA ticket's serial is {SLOT / UTXO_BIT:.0f} times a UTXO's spent bit, and is freed within one epoch.")
    if out_path:
        with open(out_path, "w") as f:
            f.write(json.dumps({"slot_bytes": SLOT, "utxo_bit_bytes": UTXO_BIT, "rows": rows}, indent=1) + "\n")
        print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
