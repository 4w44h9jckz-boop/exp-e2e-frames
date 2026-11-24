# Experiment 32, register: an identity's leaf at version 0 and its registration tag, from one s.
#
# Private: s, rec, salt, the rule and its keys. Proves:
#   L0 = H(H([TAU_LEAF, g^0], s), H(R, H(rec, salt)))
#   Q = H([TAU_REG, 0], s)
# The keystore appends L0 and accepts each Q once.
# public_input: the two cells of D = H(L0, Q)


def main():
    s = StackBuf(2)
    hint_witness(s, "w")
    rec = StackBuf(2)
    hint_witness(rec, "w")
    salt = StackBuf(2)
    hint_witness(salt, "w")
    rule = hint_witness("rule")
    keys = StackBuf(6)
    hint_witness(keys, "keys")

    rd = StackBuf(2)
    rule_digest(rule, keys, rd)
    lf = StackBuf(2)
    leaf_of(s, 1, rd, rec, salt, lf)
    q = StackBuf(2)
    keccak([TAU_REG, 0], s, q)
    d = StackBuf(2)
    keccak(lf, q, d)
    publish(d)
    return
