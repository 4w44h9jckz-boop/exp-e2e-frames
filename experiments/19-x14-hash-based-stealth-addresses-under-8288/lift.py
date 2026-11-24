"""Experiment 19 (X14), version 2a: lift leanVM's in-circuit leanSPHINCS verifier into a program of
its own.

leanVM at 3cbac04 verifies leanSPHINCS only inside its aggregation guest,
crates/rec_aggregation/guests/lean_ethereum.py (dual MIT and Apache-2.0). This script takes
`verify_sig_lean_sphincs` and everything it reaches there, functions and constants, verbatim and in
the guest's order, and fills the guest's `*_PLACEHOLDER` names the closure uses with the values
leanVM's own host computes (`placeholder_map` in crates/rec_aggregation/src/aggregation.rs,
dumped by its CLI under DBG_PLACEHOLDERS). It rewrites the part of the target program between
the two LIFTED markers and leaves the rest, the program's own statement, alone.

usage (from the repository root):
  DBG_PLACEHOLDERS=<dump> work/leanVM/target/release/leanvm aggregate --sphincs 1 --log-inv-rate 1
  python3 -I experiments/19-x14-hash-based-stealth-addresses-under-8288/lift.py \
      work/leanVM/crates/rec_aggregation/guests/lean_ethereum.py <dump> <program.py>

Standard library only. The guest is Python-shaped zkDSL, so Python's own parser reads it.
"""
import ast
import re
import sys

ROOTS = ["verify_sig_lean_sphincs"]
BEGIN = "# ---- LIFTED: begin"
END = "# ---- LIFTED: end"


def closure(tree):
    defs = {}
    for node in tree.body:
        if isinstance(node, ast.FunctionDef):
            defs[node.name] = node
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    defs[target.id] = node
    need, todo = set(), list(ROOTS)
    while todo:
        name = todo.pop()
        if name in need or name not in defs:
            continue
        need.add(name)
        todo += [n.id for n in ast.walk(defs[name]) if isinstance(n, ast.Name)]
    return [node for node in tree.body if node in {defs[n] for n in need}]


def segment(lines, node):
    """The node's source lines with the comment lines directly above it."""
    start = min([node.lineno] + [d.lineno for d in getattr(node, "decorator_list", [])]) - 1
    while start > 0 and lines[start - 1].lstrip().startswith("#") and not lines[start - 1].startswith("# ---") and not lines[start - 1].startswith("# ==="):
        start -= 1
    return lines[start:node.end_lineno]


def main(guest_path, dump_path, program_path):
    guest = open(guest_path).read()
    lines = guest.split("\n")
    values = {}
    for line in open(dump_path):
        key, _, value = line.rstrip("\n").partition(" = ")
        values[key] = value
    out = []
    previous = None
    for node in closure(ast.parse(guest)):
        if isinstance(node, ast.FunctionDef) and not isinstance(previous, ast.FunctionDef):
            out += ["", ""]
        out += segment(lines, node)
        if isinstance(node, ast.FunctionDef):
            out += ["", ""]
        previous = node
    text = "\n".join(out).rstrip("\n") + "\n"
    used = sorted(set(re.findall(r"\b[A-Z0-9_]+_PLACEHOLDER\b", text)))
    for key in used:
        if key not in values:
            sys.exit(f"no value for {key} in {dump_path}")
        text = re.sub(rf"\b{key}\b", values[key], text)
    program = open(program_path).read()
    head, _, rest = program.partition(BEGIN)
    _, _, tail = rest.partition(END)
    if not rest or not tail:
        sys.exit(f"{program_path} has no LIFTED markers")
    banner = (
        f"{BEGIN} (lift.py: leanVM 3cbac04, crates/rec_aggregation/guests/lean_ethereum.py,\n"
        "# MIT or Apache-2.0, copyright 2026 leanEthereum; verbatim, with its placeholders filled\n"
        "# by leanVM's own host)\n"
    )
    open(program_path, "w").write(head + banner + text + END + tail)
    print(f"lifted {sum(isinstance(n, ast.FunctionDef) for n in closure(ast.parse(guest)))} functions, filled {len(used)} placeholders")


if __name__ == "__main__":
    main(*sys.argv[1:4])
