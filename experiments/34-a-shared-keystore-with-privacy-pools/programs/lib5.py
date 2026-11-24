# Experiment 34, arm B: what arm B adds to experiment 32's library and arm A's lib4.py, for the
# programs over a leaf with two rules, R = H(R_main, R_scope):
#
#   main_rule_body(0), main4:   the main rule signed m; publishes H(H(C, m), H(rho, 0)) for the
#                               account C = H(H([TAU_PAY, 0], H([TAU_ID, 0], s)), r)
#   main_rule_body(1), own_main: the main rule signed m; publishes H(H(T, m), H(rho, 0)) for the
#                               owner tag T = H([TAU_TAG, i], s)
#   scoped_own_body, own_scoped: the scoped key signed m; publishes H(H(T, m), H(rho, C')) for an
#                               account C' = H(H([TAU_PAY, 0], H([TAU_ID, 0], s)), r') of the identity
#
# rho = H(leaf root, revocation root), and the leaf is unrevoked under it, as in experiment 32.

TAU_TAG = 1263730954


@inline
def unrevoked_root(s, ver, rd, rec, salt, tab, rho):
    lf = StackBuf(2)
    leaf_of(s, ver, rd, rec, salt, lf)
    troot = StackBuf(2)
    path_root(lf, troot)
    n = StackBuf(2)
    keccak([TAU_REV, ver], s, n)
    nroot = StackBuf(2)
    absent(n[0], tab, nroot)
    keccak(troot, nroot, rho)
    return


@inline
def main_rule_body(mode: Const):
    tab = HeapBuf(TAB_CELLS)
    fill_tables(tab)
    byte_bits = HeapBuf(SP_BYTE_VALUES)
    for v in unroll(0, SP_BYTE_VALUES):
        byte_bits[GEN ** v] = v

    s = StackBuf(2)
    hint_witness(s, "w")
    r = StackBuf(2)
    hint_witness(r, "w")
    m = StackBuf(2)
    hint_witness(m, "w")
    rec = StackBuf(2)
    hint_witness(rec, "w")
    salt = StackBuf(2)
    hint_witness(salt, "w")
    rscope = StackBuf(2)
    hint_witness(rscope, "w")
    ver = hint_witness("version")
    assert log(ver) < 256
    idx = hint_witness("index")
    rule = hint_witness("rule")
    keys = StackBuf(6)
    hint_witness(keys, "keys")

    check_rule(rule, keys, m, byte_bits)

    rm = StackBuf(2)
    rule_digest(rule, keys, rm)
    rd = StackBuf(2)
    keccak(rm, rscope, rd)
    rho = StackBuf(2)
    unrevoked_root(s, ver, rd, rec, salt, tab, rho)

    a = StackBuf(2)
    if const(mode == 0):
        k = StackBuf(2)
        keccak([TAU_ID, 0], s, k)
        kpay = StackBuf(2)
        keccak([TAU_PAY, 0], k, kpay)
        keccak(kpay, r, a)
    else:
        keccak([TAU_TAG, idx], s, a)

    am = StackBuf(2)
    keccak(a, m, am)
    rz = StackBuf(2)
    keccak(rho, [0, 0], rz)
    d = StackBuf(2)
    keccak(am, rz, d)
    publish(d)
    return


@inline
def scoped_own_body():
    tab = HeapBuf(TAB_CELLS)
    fill_tables(tab)
    byte_bits = HeapBuf(SP_BYTE_VALUES)
    for v in unroll(0, SP_BYTE_VALUES):
        byte_bits[GEN ** v] = v

    s = StackBuf(2)
    hint_witness(s, "w")
    rp = StackBuf(2)
    hint_witness(rp, "w")
    m = StackBuf(2)
    hint_witness(m, "w")
    rec = StackBuf(2)
    hint_witness(rec, "w")
    salt = StackBuf(2)
    hint_witness(salt, "w")
    rmain = StackBuf(2)
    hint_witness(rmain, "w")
    lam = StackBuf(2)
    hint_witness(lam, "w")
    ver = hint_witness("version")
    assert log(ver) < 256
    idx = hint_witness("index")
    keys = StackBuf(6)
    hint_witness(keys, "keys")
    assert keys[2] == 0
    assert keys[3] == 0
    assert keys[4] == 0
    assert keys[5] == 0

    # The scoped key, key 0 of a one-key layout, signs m.
    kp = addr(keys)
    verify_one(kp, 1, m[0], m[1], byte_bits)

    sa = StackBuf(2)
    keccak([TAU_SCOPE, 0], keys[0:2], sa)
    rs = StackBuf(2)
    keccak(sa, lam, rs)
    rd = StackBuf(2)
    keccak(rmain, rs, rd)
    rho = StackBuf(2)
    unrevoked_root(s, ver, rd, rec, salt, tab, rho)

    t = StackBuf(2)
    keccak([TAU_TAG, idx], s, t)
    k = StackBuf(2)
    keccak([TAU_ID, 0], s, k)
    kpay = StackBuf(2)
    keccak([TAU_PAY, 0], k, kpay)
    cp = StackBuf(2)
    keccak(kpay, rp, cp)

    tm = StackBuf(2)
    keccak(t, m, tm)
    rx = StackBuf(2)
    keccak(rho, cp, rx)
    d = StackBuf(2)
    keccak(tm, rx, d)
    publish(d)
    return
