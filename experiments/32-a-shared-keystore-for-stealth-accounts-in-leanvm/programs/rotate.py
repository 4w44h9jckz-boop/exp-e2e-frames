# Experiment 32, rotate: the current version's keys, or the recovery keys, sign the next version's
# leaf; or the current keys cancel a queued recovery.
#
# Private: s, rec, salt, the version g^v, the rule and its keys, the leaf's path, the revocation
# entry with its path, the next leaf's rule digest R', recovery rule rec' and salt', the signatures,
# and, in recovery, the recovery rule and its keys. The mode mu is g^0 (rotate under the current
# rule), g^1 (recover under the recovery rule) or g^2 (cancel a queued recovery under the current
# rule). Proves:
#   the current leaf under the leaf tree's root, its kappa absent from the revocation tree, and
#   rho = H(leaf root, revocation root), as spend.py does
#   L' = H(H([TAU_LEAF, g g^v], s), H(R', H(rec', salt'))), from the same s at the next version
#   m_rot = H([TAU_ROT, mu], L') signed under the current rule, or, at mu = g, under the recovery
#   rule whose digest is rec
# public_input: the two cells of D = H(H(rho, N), H(L', [mu, 0]))


def main():
    tab = HeapBuf(TAB_CELLS)
    fill_tables(tab)
    byte_bits = HeapBuf(SP_BYTE_VALUES)
    for v in unroll(0, SP_BYTE_VALUES):
        byte_bits[GEN ** v] = v

    s = StackBuf(2)
    hint_witness(s, "w")
    rec = StackBuf(2)
    hint_witness(rec, "w")
    salt = StackBuf(2)
    hint_witness(salt, "w")
    rdn = StackBuf(2)
    hint_witness(rdn, "w")
    recn = StackBuf(2)
    hint_witness(recn, "w")
    saltn = StackBuf(2)
    hint_witness(saltn, "w")
    ver = hint_witness("version")
    assert log(ver) < 255
    mode = hint_witness("mode")
    assert log(mode) < 3
    rule = hint_witness("rule")
    keys = StackBuf(6)
    hint_witness(keys, "keys")

    rd = StackBuf(2)
    rule_digest(rule, keys, rd)
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

    lfn = StackBuf(2)
    leaf_of(s, ver * GEN, rdn, recn, saltn, lfn)
    mrot = StackBuf(2)
    keccak([TAU_ROT, mode], lfn, mrot)

    if mode == GEN:
        rrule = hint_witness("rrule")
        rkeys = StackBuf(6)
        hint_witness(rkeys, "rkeys")
        rr = StackBuf(2)
        rule_digest(rrule, rkeys, rr)
        assert rr[0] == rec[0]
        assert rr[1] == rec[1]
        check_rule(rrule, rkeys, mrot, byte_bits)
    else:
        check_rule(rule, keys, mrot, byte_bits)

    rn = StackBuf(2)
    keccak(rho, n, rn)
    lm = StackBuf(2)
    keccak(lfn, [mode, 0], lm)
    d = StackBuf(2)
    keccak(rn, lm, d)
    publish(d)
    return
