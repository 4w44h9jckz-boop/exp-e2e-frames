"""Experiment 25, arm 0: the record of one reproduction, read from the test's log.

The log stays in work/, since it is INTMAX3's test's own output. The record keeps the exit, the
time, the peak memory, the test's result lines, every line that names gas, and the lines the test
itself prints for each proof and each step ([PW BENCH] and [PW E2E]), each cut to 300 characters.

It also keeps the run's settings and what bounded it: the rayon thread count the run was given,
the memory limit of the control group it ran in, and any kernel line recording a process the
kernel's out-of-memory killer stopped during the run.

usage: python3 summarize.py <log> <out.json> <label> <pin> <exit> <seconds> <peak KiB>
                            <threads> <memory limit bytes> <kernel lines file> [chain]
"""

import json
import re
import sys


def main(argv):
    log, out, label, pin, status, secs, peak, threads, limit, kernel = argv[1:11]
    chain = argv[11] if len(argv) > 11 else "anvil"
    try:
        kernel_lines = [l.strip()[:400] for l in open(kernel, encoding="utf8", errors="replace")
                        if l.strip()]
    except OSError:
        kernel_lines = []
    lines = open(log, encoding="utf8", errors="replace").read().splitlines()

    def keep(pattern, limit):
        return [l.strip()[:300] for l in lines if re.search(pattern, l)][:limit]

    record = {
        "experiment": 25,
        "arm": 0,
        "step": f"INTMAX3's own partial-withdrawal end-to-end test, on {chain}",
        "run": label,
        "intmax3": pin,
        "command": "cargo test --release --locked --test partial_withdrawal_e2e "
        "partial_withdrawal_e2e_anvil -- --nocapture",
        "exit": int(status),
        "seconds": int(secs),
        "peakRssKiB": int(peak or 0),
        "rayonThreads": threads or "unset (rayon's default: one per core)",
        "memoryLimitBytes": int(limit) if limit.isdigit() else None,
        "oomKills": kernel_lines,
        "testResult": [l.strip() for l in lines
                       if l.startswith("test result:") or l.startswith("test ")][-10:],
        "proofLines": keep(r"\[PW BENCH\]", 100),
        "stepLines": keep(r"\[PW E2E\]", 200),
        "gasLines": keep(r"(?i)\bgas\b", 200),
        "panicLines": keep(r"panicked at|^thread '", 20),
    }
    with open(out, "w") as f:
        json.dump(record, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main(sys.argv)
