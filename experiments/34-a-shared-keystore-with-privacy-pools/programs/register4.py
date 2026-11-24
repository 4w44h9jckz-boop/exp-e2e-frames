# Experiment 34, register4: an identity's leaf at version 0 with two rules, its registration tag,
# and the main rule's signature on the list.
#
# Private: s, rec, salt, the main rule and its keys, the scoped key, lambda, and the signatures.
# Proves:
#   L0 = H(H([TAU_LEAF, g^0], s), H(R, H(rec, salt))), R = H(R_main, H(H([TAU_SCOPE, 0], k_scope), lambda))
#   Q = H([TAU_REG, 0], s)
#   the main rule accepts signatures on H([TAU_LIST, 0], lambda)
# public_input: the two cells of D = H(L0, Q), experiment 32's register digest, so experiment 33's
# keystore contract takes it under this program's key


def main():
    byte_bits = HeapBuf(SP_BYTE_VALUES)
    for v in unroll(0, SP_BYTE_VALUES):
        byte_bits[GEN ** v] = v

    s = StackBuf(2)
    hint_witness(s, "w")
    rec = StackBuf(2)
    hint_witness(rec, "w")
    salt = StackBuf(2)
    hint_witness(salt, "w")
    kscope = StackBuf(2)
    hint_witness(kscope, "w")
    lam = StackBuf(2)
    hint_witness(lam, "w")
    rule = hint_witness("rule")
    keys = StackBuf(6)
    hint_witness(keys, "keys")

    ml = StackBuf(2)
    keccak([TAU_LIST, 0], lam, ml)
    check_rule(rule, keys, ml, byte_bits)

    rm = StackBuf(2)
    rule_digest(rule, keys, rm)
    rs = StackBuf(2)
    scope_digest(kscope, lam, rs)
    rd = StackBuf(2)
    keccak(rm, rs, rd)
    lf = StackBuf(2)
    leaf_of(s, 1, rd, rec, salt, lf)
    q = StackBuf(2)
    keccak([TAU_REG, 0], s, q)
    d = StackBuf(2)
    keccak(lf, q, d)
    publish(d)
    return
