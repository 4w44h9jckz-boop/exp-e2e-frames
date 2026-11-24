# Experiment 32, spend: an account whose identity holds an unrevoked leaf in the keystore spends.
#
# Private: s, r, m, rec, salt, the version g^v, the rule and its keys, the signatures, the leaf's
# path, and the revocation entry with its path. Proves:
#   C = H(H([TAU_PAY, 0], H([TAU_ID, 0], s)), r)
#   L = H(H([TAU_LEAF, g^v], s), H(R, H(rec, salt))) under the leaf tree's root
#   kappa, the first cell of N = H([TAU_REV, g^v], s), absent from the revocation tree
#   rho = H(leaf root, revocation root)
#   the rule accepts signatures on m
# public_input: the two cells of D = H(H(C, m), rho)


def main():
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
    ver = hint_witness("version")
    assert log(ver) < 256
    rule = hint_witness("rule")
    keys = StackBuf(6)
    hint_witness(keys, "keys")

    check_rule(rule, keys, m, byte_bits)

    k = StackBuf(2)
    keccak([TAU_ID, 0], s, k)
    kpay = StackBuf(2)
    keccak([TAU_PAY, 0], k, kpay)
    c = StackBuf(2)
    keccak(kpay, r, c)

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
    cm = StackBuf(2)
    keccak(c, m, cm)
    d = StackBuf(2)
    keccak(cm, rho, d)
    publish(d)
    return
