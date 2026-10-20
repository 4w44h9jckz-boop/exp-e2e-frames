"""The third implementation against the vector set: prints its answers as JSON.

usage: python3 experiments/03-i2-one-frame-format/py/run.py VECTORS_DIR

It judges nothing; run.ts compares every implementation's answers with the
expected values.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import frametx as F  # noqa: E402


def h(b: bytes) -> str:
    return "0x" + b.hex()


def main() -> None:
    d = sys.argv[1]
    load = lambda f: json.load(open(os.path.join(d, f)))["cases"]
    txs = []
    for c in load("transactions.json"):
        try:
            t = F.FrameTx(c["fields"])
            txs.append({"name": c["name"], "raw": h(t.raw()), "hash": h(t.hash()), "sigHash": h(t.sig_hash())})
        except (F.Invalid, ValueError, KeyError) as e:
            txs.append({"name": c["name"], "error": str(e)})
    rej = []
    for c in load("reject.json"):
        try:
            F.decode(bytes.fromhex(c["raw"][2:]))
            rej.append({"name": c["name"], "refused": False})
        except F.Invalid as e:
            rej.append({"name": c["name"], "refused": True, "error": str(e)})
    dig = []
    for c in load("execution-digest.json"):
        t = F.from_raw(bytes.fromhex(c["raw"][2:]))
        dig.append({"name": c["name"], "domainSeparator": h(F.domain_separator(t)),
                    "structHash": h(F.execution_struct_hash(t)), "executionDigest": h(F.execution_digest(t))})
    print(json.dumps({"implementation": "from the texts (Python)", "transactions": txs,
                      "reject": rej, "executionDigest": dig}))


if __name__ == "__main__":
    main()
