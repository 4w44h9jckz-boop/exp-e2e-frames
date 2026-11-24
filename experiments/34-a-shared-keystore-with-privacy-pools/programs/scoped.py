# Experiment 34, scoped: the leaf's scoped key moves the account's funds into the pool, with the
# precommitment P bound to the list the main rule signed.
#
# Private: s, r, m, rec, salt, R_main, lambda, P, the version, the scoped key, its signature, the
# leaf's path, the revocation entry with its path, and P's path in the list. Proves, beside what
# experiment 32's spend proves about the account, the leaf and the revocation tree:
#   R = H(R_main, H(H([TAU_SCOPE, 0], k_scope), lambda)) is the leaf's rule digest
#   k_scope signs m
#   P is a leaf of the depth-4 list under lambda
# public_input: the two cells of D = H(H(C, m), H(rho, P))


def main():
    scoped_body(1)
    return
