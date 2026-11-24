# Experiment 32: the keystore library, shared by spend.py, register.py and rotate.py. x32.ts
# assembles each program from this file, experiment 19's lifted leanSPHINCS verifier and its
# verify_one, and the entry point, then fills the tables in.
#
# H(x, y) is leanVM's KECCAK of two 32-byte operands, each two 16-byte cells. Each role's first
# operand starts with its own tag TAU_*, so no two roles hash the same bytes. A version v is written
# g^v, as leanVM's host writes a count.

TAU_ID = 1263730945
TAU_PAY = 1263730946
TAU_LEAF = 1263730947
TAU_REV = 1263730948
TAU_REG = 1263730949
TAU_ENT = 1263730950
TAU_ROT = 1263730951
DEPTH = 20
# h = 7 + 8Y, the primitive element of GF(2^192)^* that experiment 26 uses.
HGEN = f192(7, 8, 0)
# Y_INV, the inverse of Y for splitting a cell into its limbs, is the lifted verifier's own
# constant; x32.ts checks it equals the tool's.
# HPOW[256 p + v] = h^(v 256^p), p = 0..15.
HPOW = HPOW_PLACEHOLDER
TAB_CELLS = 6144


@inline
def fill_tables(tab):
    # tab[256 p + v]: byte v's bits at position p of a 64-bit limb, p = 0..7;
    # tab[2048 + 256 p + v]: h^(v 256^p), p = 0..15.
    for p in unroll(0, 8):
        for v in unroll(0, 256):
            tab[GEN ** (256 * p + v)] = const(v * 256 ** p)
    for p in unroll(0, 16):
        for v in unroll(0, 256):
            tab[GEN ** (2048 + 256 * p + v)] = HPOW[256 * p + v]
    return


def coef(limb, tab, base: Const):
    # h^(x 256^base) for the 64-bit limb x, read from eight hinted bytes g^b, each range checked
    # and tied back to the limb through its bits.
    by = StackBuf(8)
    hint_witness(by, "bytes")
    word = 0
    hx = 1
    for p in unroll(0, 8):
        gv = by[p]
        assert log(gv) < 256
        ptr = tab * gv * GEN ** (256 * p)
        word += ptr[1]
        hx *= ptr[GEN ** (2048 + 256 * base)]
    assert word == limb
    return hx


def read128(x, tab):
    # h^x for the cell x read as an unsigned 128-bit integer: its two 64-bit limbs, proven to be
    # its limbs, then each limb's bytes.
    lo = StackBuf(1)
    hint_f192_limbs(lo, x)
    hi = (x + lo[0]) * Y_INV
    assert_in_k(lo[0], hi)
    hl = coef(lo[0], tab, 0)
    hh = coef(hi, tab, 8)
    return hl * hh


@inline
def rule_digest(rule, keys, out):
    # R = H(H([rule, 0], k0), H(k1, k2)), version 2a's key commitment.
    rk = StackBuf(2)
    keccak([rule, 0], keys[0:2], rk)
    kk = StackBuf(2)
    keccak(keys[2:4], keys[4:6], kk)
    keccak(rk, kk, out)
    return


@inline
def leaf_of(s, v, rd, rec, salt, out):
    # L = H(H([TAU_LEAF, g^v], s), H(R, H(rec, salt))).
    a = StackBuf(2)
    keccak([TAU_LEAF, v], s, a)
    b = StackBuf(2)
    keccak(rec, salt, b)
    c = StackBuf(2)
    keccak(rd, b, c)
    keccak(a, c, out)
    return


@inline
def path_root(start, out):
    # The root of a depth-20 tree above `start`: at each level both children are hinted in order
    # and the current node is checked to be the one the hinted bit names, left at 0, right at 1.
    cur0 = start[0]
    cur1 = start[1]
    for level in unroll(0, DEPTH):
        kids = StackBuf(4)
        hint_witness(kids, "path")
        b = hint_witness("bits")
        assert b * (b + 1) == 0
        assert cur0 == kids[0] + b * (kids[0] + kids[2])
        assert cur1 == kids[1] + b * (kids[1] + kids[3])
        if const(level + 1 == DEPTH):
            keccak(kids[0:2], kids[2:4], out)
        else:
            parent = StackBuf(2)
            keccak(kids[0:2], kids[2:4], parent)
            cur0 = parent[0]
            cur1 = parent[1]
    return


@inline
def absent(kappa, tab, nroot):
    # kappa is not a revocation key: an entry (a, b) of the revocation tree, under nroot, with
    # a < kappa < b, each shown as h^kappa = h^a h h^d1 and h^b = h^kappa h h^d2 for hinted
    # 128-bit gaps. Every exponent is below 2^130, so each is an equation of integers.
    ent = StackBuf(2)
    hint_witness(ent, "entry")
    e = StackBuf(2)
    keccak([TAU_ENT, 0], ent, e)
    path_root(e, nroot)
    gaps = StackBuf(2)
    hint_witness(gaps, "gaps")
    ha = read128(ent[0], tab)
    hb = read128(ent[1], tab)
    hk = read128(kappa, tab)
    hd1 = read128(gaps[0], tab)
    hd2 = read128(gaps[1], tab)
    assert hk == ha * HGEN * hd1
    assert hb == hk * HGEN * hd2
    return


@inline
def check_rule(rule, keys, m, byte_bits):
    # The rule accepts leanSPHINCS signatures on m: rule 1, key 0 signs; rule 2, two different
    # keys of the three sign. Version 2a's main, as a function of its rule and keys.
    kp = addr(keys)
    first = hint_witness("signer")
    assert log(first) < 3
    verify_one(kp, first, m[0], m[1], byte_bits)
    if rule == 1:
        assert first == 1
    else:
        assert rule == 2
        second = hint_witness("signer")
        assert log(second) < 3
        assert first != second
        verify_one(kp, second, m[0], m[1], byte_bits)
    return


@inline
def publish(d):
    p = GEN ** 0
    p[1] = d[0]
    p[GEN] = d[1]
    return
