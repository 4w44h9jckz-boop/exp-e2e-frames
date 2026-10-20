"""secp256k1 public-key recovery and P-256 verification, standard library only.

Used only to generate the vector set: a mined signature over the canonical
signature hash was accepted by the chain, so recovering its signer from a
computed hash confirms that hash is the chain's. Not constant-time; never use it
to sign.
"""

from __future__ import annotations


class _Curve:
    def __init__(self, p, a, b, n, gx, gy):
        self.p, self.a, self.b, self.n, self.g = p, a, b, n, (gx, gy)

    def add(self, P, Q):
        if P is None:
            return Q
        if Q is None:
            return P
        p = self.p
        if P[0] == Q[0] and (P[1] + Q[1]) % p == 0:
            return None
        if P == Q:
            lam = (3 * P[0] * P[0] + self.a) * pow(2 * P[1], -1, p) % p
        else:
            lam = (Q[1] - P[1]) * pow(Q[0] - P[0], -1, p) % p
        x = (lam * lam - P[0] - Q[0]) % p
        return x, (lam * (P[0] - x) - P[1]) % p

    def mul(self, k, P):
        R = None
        while k:
            if k & 1:
                R = self.add(R, P)
            P = self.add(P, P)
            k >>= 1
        return R


SECP256K1 = _Curve(
    p=2**256 - 2**32 - 977, a=0, b=7,
    n=0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141,
    gx=0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
    gy=0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8,
)
P256 = _Curve(
    p=0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF,
    a=0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFC,
    b=0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B,
    n=0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551,
    gx=0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
    gy=0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5,
)


def secp256k1_recover(digest: bytes, v: int, r: int, s: int) -> tuple[int, int] | None:
    c = SECP256K1
    if v > 1 or not (0 < r < c.n) or not (0 < s < c.n):
        return None
    x = r
    y2 = (pow(x, 3, c.p) + c.b) % c.p
    y = pow(y2, (c.p + 1) // 4, c.p)
    if y * y % c.p != y2:
        return None
    if y % 2 != v:
        y = c.p - y
    R = (x, y)
    e = int.from_bytes(digest, "big") % c.n
    rinv = pow(r, -1, c.n)
    Q = c.add(c.mul(s * rinv % c.n, R), c.mul((-e * rinv) % c.n, c.g))
    return Q


def p256_verify(digest: bytes, r: int, s: int, qx: int, qy: int) -> bool:
    c = P256
    if not (0 < r < c.n and 0 < s < c.n):
        return False
    e = int.from_bytes(digest, "big") % c.n
    w = pow(s, -1, c.n)
    X = c.add(c.mul(e * w % c.n, c.g), c.mul(r * w % c.n, (qx, qy)))
    return X is not None and X[0] % c.n == r
