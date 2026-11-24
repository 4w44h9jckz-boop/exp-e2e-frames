# Experiment 19 (X14), version 1: a stealth account spent by a proof of its secrets.
#
# K = H(k, TAG_KEY), C = H(K, r), T = H(H(k, r), m), with k, r and m private. The proof publishes
# D = H(H(C, m), T), which the account recomputes from its stored C, the message it rebuilds and
# the tag T in calldata, and finds among the transaction's dependencies as the public-input hash.
# H is the leanVM hash, Keccak-256 over the cells' bytes; a cell is 16 bytes, a digest two cells.
# public_input: the two cells of D
from snark_lib import *


def main():
    k = StackBuf(2)
    hint_witness(k, "k")
    r = StackBuf(2)
    hint_witness(r, "r")
    m = StackBuf(2)
    hint_witness(m, "m")
    tag_key = StackBuf(2)
    tag_key[0] = 1
    tag_key[1] = 0
    key = StackBuf(2)
    keccak(k, tag_key, key)
    c = StackBuf(2)
    keccak(key, r, c)
    kr = StackBuf(2)
    keccak(k, r, kr)
    t = StackBuf(2)
    keccak(kr, m, t)
    cm = StackBuf(2)
    keccak(c, m, cm)
    d = StackBuf(2)
    keccak(cm, t, d)
    p = GEN ** 0
    p[1] = d[0]
    p[GEN] = d[1]
    return
