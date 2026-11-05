#!/usr/bin/env bash
# Experiment 25 (X18), arm 0's first reproduction: INTMAX3's own release end-to-end test of the
# partial-withdrawal path, run as its runbook gives it (doc/tasks/regen-and-redeploy-runbook.md):
#   cargo test --release --locked --test partial_withdrawal_e2e partial_withdrawal_e2e_anvil -- --nocapture
# It deploys from INTMAX3's proof-free configs, posts four blocks to anvil as blob transactions,
# finalizes them with a real four-block validity proof (MLE/WHIR) and settles the burn. This step
# runs on anvil, as INTMAX3's test does; the same flow on experiment 22's local chain follows it.
# The test's output stays in work/; the record keeps the exit, the time, the peak memory and every
# line the test prints that names gas.
#
# usage: bash experiments/25-x18-intmax3-withdrawals-as-l1-5-jobs/reproduce.sh <n>-<label>
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
label="${1:?usage: reproduce.sh <n>-<label>}"
pin=979318dbf48eee360235fab9b5675b82e8cfde12
dir="$root/work/intmax3-${pin:0:12}"
[ "$(git -C "$dir" rev-parse HEAD)" = "$pin" ] || { echo "run build.sh first"; exit 1; }
log="$root/work/intmax3-reproduce-$label.log"
out="$here/results/$label.json"
t0=$(date +%s)
status=0
( cd "$dir" && /usr/bin/time -v cargo test --release --locked --test partial_withdrawal_e2e \
    partial_withdrawal_e2e_anvil -- --nocapture ) >"$log" 2>&1 || status=$?
secs=$(( $(date +%s) - t0 ))
peak=$(awk -F: '/Maximum resident set size/ {gsub(/ /,"",$2); print $2}' "$log" | tail -1)
python3 - "$log" "$out" <<EOF
import json, re, sys
log, out = sys.argv[1], sys.argv[2]
lines = open(log, encoding="utf8", errors="replace").read().splitlines()
gas = [l.strip()[:300] for l in lines if re.search(r"\bgas\b", l, re.I)][:200]
result = [l.strip() for l in lines if l.startswith("test result:") or l.startswith("test ")][-10:]
json.dump({
  "experiment": 25, "arm": 0, "step": "INTMAX3's own partial-withdrawal end-to-end test, on anvil",
  "run": "$label", "intmax3": "$pin",
  "command": "cargo test --release --locked --test partial_withdrawal_e2e partial_withdrawal_e2e_anvil -- --nocapture",
  "exit": $status, "seconds": $secs, "peakRssKiB": int("${peak:-0}" or 0),
  "testResult": result, "gasLines": gas,
}, open(out, "w"), indent=2)
open(out, "a").write("\n")
EOF
echo "exit $status in $secs s; recorded $out"
exit $status
