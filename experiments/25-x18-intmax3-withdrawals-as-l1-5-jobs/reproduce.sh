#!/usr/bin/env bash
# Experiment 25 (X18), arm 0's reproduction: INTMAX3's own release end-to-end test of the
# partial-withdrawal path, run as its runbook gives it (doc/tasks/regen-and-redeploy-runbook.md):
#   cargo test --release --locked --test partial_withdrawal_e2e partial_withdrawal_e2e_anvil -- --nocapture
# It deploys from INTMAX3's proof-free configs, posts four blocks to anvil as blob transactions,
# finalizes them with a real four-block validity proof (MLE/WHIR) and settles the burn. This step
# runs on anvil, as INTMAX3's test does; the same flow on experiment 22's local chain follows it.
# The test's output stays in work/; summarize.py writes the record from it.
#
# RAYON_NUM_THREADS, if set, is passed to the test and recorded. Nothing in INTMAX3 changes.
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
kernel="$root/work/intmax3-reproduce-$label.kernel"
out="$here/results/$label.json"
# The memory limit of this shell's control group (version 1 or 2), if one is set.
cg="$(awk -F: '$2=="memory" || $2=="" {print $3; exit}' /proc/self/cgroup)"
limit="$(cat "/sys/fs/cgroup/memory$cg/memory.limit_in_bytes" 2>/dev/null \
  || cat "/sys/fs/cgroup$cg/memory.max" 2>/dev/null || echo unknown)"
up0=$(cut -d' ' -f1 /proc/uptime)
t0=$(date +%s)
status=0
# Peak memory of the test and everything it starts, from the kernel's accounting of the children.
( cd "$dir" && python3 -c '
import resource, subprocess, sys
r = subprocess.call(["cargo", "test", "--release", "--locked", "--test", "partial_withdrawal_e2e",
                     "partial_withdrawal_e2e_anvil", "--", "--nocapture"])
print("PEAK_RSS_KIB", resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)
sys.exit(r)' ) >"$log" 2>&1 || status=$?
secs=$(( $(date +%s) - t0 ))
peak=$(awk '/^PEAK_RSS_KIB/ {print $2}' "$log" | tail -1)
# Kernel lines, since the run began, that record a process stopped for memory.
{ dmesg 2>/dev/null || true; } | awk -v t="$up0" '
  { s=$0; sub(/^\[ */, "", s); split(s, a, "]"); if (a[1]+0 >= t+0) print }' \
  | grep -E 'Killed process' >"$kernel" || true
python3 "$here/summarize.py" "$log" "$out" "$label" "$pin" "$status" "$secs" "${peak:-0}" \
  "${RAYON_NUM_THREADS:-}" "$limit" "$kernel"
echo "exit $status in $secs s; recorded $out"
exit $status
