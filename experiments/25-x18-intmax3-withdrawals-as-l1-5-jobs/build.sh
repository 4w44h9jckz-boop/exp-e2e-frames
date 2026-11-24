#!/usr/bin/env bash
# Experiment 25 (X18), arm 0's build: INTMAX3 at its pinned commit, from its own repository, into
# the gitignored work/ directory. Nothing of INTMAX3's is copied into this repository: its Rust
# circuits declare no licence. Its submodules are taken at their gitlinks, as its .gitmodules asks
# ("Release builds must use git submodule update --init --recursive"), and its Rust toolchain is
# the one its rust-toolchain.toml pins.
#
# usage: bash experiments/25-x18-intmax3-withdrawals-as-l1-5-jobs/build.sh <n>-<label>
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
label="${1:?usage: build.sh <n>-<label>}"
pin=979318dbf48eee360235fab9b5675b82e8cfde12
dir="$root/work/intmax3-${pin:0:12}"
out="$here/results/$label.json"
mkdir -p "$here/results"
log="$root/work/intmax3-build-$label.log"
: > "$log"
t0=$(date +%s)
stamp() { echo "$(( $(date +%s) - t0 )) s: $*" | tee -a "$log"; }

if [ ! -d "$dir/.git" ]; then
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" fetch -q --depth 1 https://github.com/InternetMaximalism/intmax3-zkp "$pin"
  git -C "$dir" checkout -q FETCH_HEAD
fi
[ "$(git -C "$dir" rev-parse HEAD)" = "$pin" ] || { echo "$dir is not at $pin"; exit 1; }
stamp "checked out $pin"
git -C "$dir" submodule update --init --recursive --depth 1 >>"$log" 2>&1
stamp "submodules at their gitlinks"
subs="$(git -C "$dir" submodule status --recursive | awk '{print $2": "$1}' | tr -d '+-')"
toolchain="$(cd "$dir" && rustc --version)"
stamp "toolchain $toolchain"

disk() { df -k "$dir" | awk 'NR==2 {print $4}'; }
free0=$(disk)
rust_status=0
( cd "$dir" && cargo build --release ) >>"$log" 2>&1 || rust_status=$?
stamp "cargo build --release: exit $rust_status"
forge_status=0
if command -v forge >/dev/null; then
  ( cd "$dir/contracts" && forge build ) >>"$log" 2>&1 || forge_status=$?
else
  forge_status=127
fi
stamp "forge build: exit $forge_status"
free1=$(disk)
target_kb=$(du -sk "$dir/target" 2>/dev/null | awk '{print $1}')

python3 - "$out" <<EOF
import json, sys
json.dump({
  "experiment": 25, "arm": 0, "step": "build", "run": "$label",
  "intmax3": {"url": "https://github.com/InternetMaximalism/intmax3-zkp", "commit": "$pin",
              "submodules": """$subs""".strip().splitlines()},
  "toolchain": "$toolchain",
  "command": "bash experiments/25-x18-intmax3-withdrawals-as-l1-5-jobs/build.sh $label",
  "cargoBuildRelease": {"exit": $rust_status},
  "forgeBuild": {"exit": $forge_status},
  "seconds": $(( $(date +%s) - t0 )),
  "targetDirKiB": int("${target_kb:-0}" or 0),
  "freeDiskKiB": {"before": $free0, "after": $free1},
  "machine": {"cores": $(nproc), "memoryKiB": $(awk '/MemTotal/ {print $2}' /proc/meminfo)},
}, open(sys.argv[1], "w"), indent=2)
open(sys.argv[1], "a").write("\n")
EOF
stamp "recorded $out"
[ "$rust_status" = 0 ] && [ "$forge_status" = 0 ]
