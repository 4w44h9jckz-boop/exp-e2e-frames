# Experiment 26 (X19), the user's statement: one channel's transfer, proved over the member's own
# witness. A template: the host writes in the tables (x19-tool), and the program's key is keccak256
# of the instantiated file, as docs/leanvm-program-layout.md fixes it.
#
# Statement. Private: the balance b, the amount a, the new balance b', the old and new salts s0 and
# s1, and the amount's blinding r. Public, through the digest only: the keys' hash kh, the fee f,
# and the transfer leaf's other fields. With every integer below 2^64:
#   b = b' + a + f
#   c0 = H(B(b), s0)    c1 = H(B(b'), s1)    A = H(B(a), r)
#   oldLeaf = H(kh, c0)    newLeaf = H(kh, c1)
#   T = H(H(H(chan, c1), H(to, A)), H(H(B(f), expiry), nullifier))
#   D = H(H(oldLeaf, newLeaf), T)
# B(x) is the 32-byte word holding x in its first eight bytes, little-endian, then zeros; H is
# keccak256 over the cells' bytes, which is keccak256 over the 32-byte words, so a contract
# recomputes D from public values with KECCAK256 alone.
#
# Integers are exponents of HGEN = 7 + 8Y, a primitive element of GF(2^192)^* (exp-frames
# experiment 41 pins its order), each read byte by byte through tables, so each is below 2^64 and
# the sum b' + a + f below 2^66, far below HGEN's order 2^192 - 1. The equation below is therefore
# one of integers, and b' >= 0 because it is read as an unsigned 64-bit integer.
#
# Witness streams (each entry's length in cells):
#   num    1 entry of 4: b, a, f, b', each the cell [x, 0]
#   bytes  4 entries of 8: g^(byte p) of b, a, f and b' in turn, p = 0..7
#   w      8 entries of 2: kh, s0, s1, r, chan, to, expiry, nullifier
# public_input: the two cells of D
from snark_lib import *

Y_INV = Y_INV_PLACEHOLDER
# HPOW[256 p + v] = HGEN^(v 256^p), p = 0..7.
HPOW = HPOW_PLACEHOLDER


@inline
def split_cell(word):
    # The two 64-bit limbs of a cell, proven to be its limbs.
    lo = StackBuf(1)
    hint_f192_limbs(lo, word)
    hi = (word + lo[0]) * Y_INV
    assert_in_k(lo[0], hi)
    return lo[0], hi


def coef(limb, tab):
    # HGEN^x for the 64-bit limb x, from its bytes, tied back to it: tab[256 p + v] holds the byte's
    # bits at position p, and tab[2048 + 256 p + v] HGEN^(v 256^p).
    by = StackBuf(8)
    hint_witness(by, "bytes")
    word = 0
    hx = 1
    for p in unroll(0, 8):
        gv = by[p]
        assert log(gv) < 256
        ptr = tab * gv * GEN ** (256 * p)
        word += ptr[1]
        hx *= ptr[GEN ** 2048]
    assert word == limb
    return hx


def main():
    # The tables: bit patterns, then powers of HGEN.
    tab = HeapBuf(4096)
    for p in unroll(0, 8):
        for v in unroll(0, 256):
            tab[GEN ** (256 * p + v)] = const(v * 256 ** p)
            tab[GEN ** (2048 + 256 * p + v)] = HPOW[256 * p + v]

    # b, a, f and b', each a 64-bit integer, as powers of HGEN.
    num = StackBuf(4)
    hint_witness(num, "num")
    hs = StackBuf(4)
    for i in unroll(0, 4):
        lo, hi = split_cell(num[i])
        assert hi == 0
        hs[i] = coef(lo, tab)
    # b = b' + a + f.
    assert hs[0] == hs[3] * hs[1] * hs[2]

    kh = StackBuf(2)
    hint_witness(kh, "w")
    s0 = StackBuf(2)
    hint_witness(s0, "w")
    s1 = StackBuf(2)
    hint_witness(s1, "w")
    r = StackBuf(2)
    hint_witness(r, "w")
    chan = StackBuf(2)
    hint_witness(chan, "w")
    to = StackBuf(2)
    hint_witness(to, "w")
    expiry = StackBuf(2)
    hint_witness(expiry, "w")
    nul = StackBuf(2)
    hint_witness(nul, "w")

    # B(b), B(a), B(f), B(b').
    bb = StackBuf(2)
    bb[0] = num[0]
    bb[1] = 0
    ba = StackBuf(2)
    ba[0] = num[1]
    ba[1] = 0
    bf = StackBuf(2)
    bf[0] = num[2]
    bf[1] = 0
    bn = StackBuf(2)
    bn[0] = num[3]
    bn[1] = 0

    c0 = StackBuf(2)
    keccak(bb, s0, c0)
    c1 = StackBuf(2)
    keccak(bn, s1, c1)
    am = StackBuf(2)
    keccak(ba, r, am)
    old_leaf = StackBuf(2)
    keccak(kh, c0, old_leaf)
    new_leaf = StackBuf(2)
    keccak(kh, c1, new_leaf)

    t1 = StackBuf(2)
    keccak(chan, c1, t1)
    t2 = StackBuf(2)
    keccak(to, am, t2)
    t3 = StackBuf(2)
    keccak(t1, t2, t3)
    t4 = StackBuf(2)
    keccak(bf, expiry, t4)
    t5 = StackBuf(2)
    keccak(t4, nul, t5)
    tl = StackBuf(2)
    keccak(t3, t5, tl)

    d1 = StackBuf(2)
    keccak(old_leaf, new_leaf, d1)
    d = StackBuf(2)
    keccak(d1, tl, d)
    p = GEN ** 0
    p[1] = d[0]
    p[GEN] = d[1]
    return
