# Experiment 34: what arm A adds to experiment 32's keystore library (its programs/lib.py), for a leaf
# with two rules. x34.ts assembles each program from experiment 32's library, this file, experiment
# 19's lifted leanSPHINCS verifier, and the entry point.
#
# The leaf's rule digest is R = H(R_main, R_scope), with R_main experiment 32's rule over the owner's
# keys and R_scope = H(H([TAU_SCOPE, 0], k_scope), lambda): the indexer's one leanSPHINCS key and the
# root of a depth-4 Keccak list of precommitments, which the main rule signs at registration as
# H([TAU_LIST, 0], lambda).

TAU_SCOPE = 1263730952
TAU_LIST = 1263730953
LIST_DEPTH = 4


@inline
def scope_digest(kscope, lam, out):
    a = StackBuf(2)
    keccak([TAU_SCOPE, 0], kscope, a)
    keccak(a, lam, out)
    return


@inline
def list_member(entry, lam):
    # entry is a leaf of the depth-4 list under lam: both children hinted in order at each level,
    # the node checked to be the one the bit names, and the top hashed into lam, which keccak's
    # write-once output turns into an equality.
    cur0 = entry[0]
    cur1 = entry[1]
    for level in unroll(0, LIST_DEPTH):
        kids = StackBuf(4)
        hint_witness(kids, "lpath")
        b = hint_witness("lbits")
        assert b * (b + 1) == 0
        assert cur0 == kids[0] + b * (kids[0] + kids[2])
        assert cur1 == kids[1] + b * (kids[1] + kids[3])
        if const(level + 1 == LIST_DEPTH):
            keccak(kids[0:2], kids[2:4], lam)
        else:
            parent = StackBuf(2)
            keccak(kids[0:2], kids[2:4], parent)
            cur0 = parent[0]
            cur1 = parent[1]
    return


@inline
def scoped_body(with_list: Const):
    # The scoped spend: experiment 32's spend for the leaf's scoped key, the precommitment P bound
    # to the list when with_list is 1.
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
    rmain = StackBuf(2)
    hint_witness(rmain, "w")
    lam = StackBuf(2)
    hint_witness(lam, "w")
    pc = StackBuf(2)
    hint_witness(pc, "w")
    ver = hint_witness("version")
    assert log(ver) < 256
    keys = StackBuf(6)
    hint_witness(keys, "keys")
    assert keys[2] == 0
    assert keys[3] == 0
    assert keys[4] == 0
    assert keys[5] == 0

    # The scoped key, key 0 of a one-key layout, signs m.
    kp = addr(keys)
    verify_one(kp, 1, m[0], m[1], byte_bits)

    k = StackBuf(2)
    keccak([TAU_ID, 0], s, k)
    kpay = StackBuf(2)
    keccak([TAU_PAY, 0], k, kpay)
    c = StackBuf(2)
    keccak(kpay, r, c)

    # scope_digest on the key's two cells, written out: a slice is only a keccak operand.
    sa = StackBuf(2)
    keccak([TAU_SCOPE, 0], keys[0:2], sa)
    rs = StackBuf(2)
    keccak(sa, lam, rs)
    rd = StackBuf(2)
    keccak(rmain, rs, rd)
    lf = StackBuf(2)
    leaf_of(s, ver, rd, rec, salt, lf)
    troot = StackBuf(2)
    path_root(lf, troot)
    n = StackBuf(2)
    keccak([TAU_REV, ver], s, n)
    nroot = StackBuf(2)
    absent(n[0], tab, nroot)
    rho = StackBuf(2)
    keccak(troot, nroot, rho)

    if const(with_list == 1):
        list_member(pc, lam)

    cm = StackBuf(2)
    keccak(c, m, cm)
    rp = StackBuf(2)
    keccak(rho, pc, rp)
    d = StackBuf(2)
    keccak(cm, rp, d)
    publish(d)
    return
