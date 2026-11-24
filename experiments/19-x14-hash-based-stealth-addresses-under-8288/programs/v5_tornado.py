# Experiment 19 (X14), version 5: Tornado Cash's withdrawal statement, in a depth-20 Keccak tree.
#
# leaf = H(ns, s); the leaf's path to `root` through 20 siblings and 20 direction bits; the
# nullifier hash nf = H(ns, TAG_NF); and `binding`, the recipient, relayer and fee hashed by the
# host, carried through as Tornado carries them. The proof publishes D = H(H(root, nf), binding),
# which the pool recomputes from the root, nullifier hash and binding in calldata.
# public_input: the two cells of D
from snark_lib import *


def main():
    ns = StackBuf(2)
    hint_witness(ns, "ns")
    s = StackBuf(2)
    hint_witness(s, "s")
    binding = StackBuf(2)
    hint_witness(binding, "binding")
    sib = StackBuf(40)
    hint_witness(sib, "path")
    bits = StackBuf(20)
    hint_witness(bits, "bits")
    node = StackBuf(42)
    keccak(ns, s, node[0:2])
    for i in unroll(0, 20):
        b = bits[i]
        assert b * b == b
        left = StackBuf(2)
        right = StackBuf(2)
        for c in unroll(0, 2):
            x = node[2 * i + c] + sib[2 * i + c]
            left[c] = node[2 * i + c] + b * x
            right[c] = sib[2 * i + c] + b * x
        keccak(left, right, node[2 * i + 2:2 * i + 4])
    tag_nf = StackBuf(2)
    tag_nf[0] = 2
    tag_nf[1] = 0
    nf = StackBuf(2)
    keccak(ns, tag_nf, nf)
    rn = StackBuf(2)
    keccak(node[40:42], nf, rn)
    d = StackBuf(2)
    keccak(rn, binding, d)
    p = GEN ** 0
    p[1] = d[0]
    p[GEN] = d[1]
    return
