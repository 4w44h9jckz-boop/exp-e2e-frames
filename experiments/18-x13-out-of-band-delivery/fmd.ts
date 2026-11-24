// Experiment 18 (X13): FMD2, fuzzy message detection, from Beck, Len, Miers and Green, "Fuzzy
// Message Detection" (IACR ePrint 2021/089), on secp256k1. Implemented from the paper; no published
// test vectors were found, so correctness is shown by the experiment's prediction 7: every true
// flag detected, and false positives at the rate.
//
//   KeyGen:  x_1..x_g random scalars, h_i = x_i G.
//   Flag:    r, z random; u = rG; w = zG; for each i, k_i = H(u, r h_i, w) and c_i = k_i XOR 1;
//            m = G'(u, c); y = (z - m) / r.  The flag is (u, y, c).
//   Extract: the first n secret keys, for a false-positive rate of 2^-n.
//   Test:    m = G'(u, c); w = mG + yu; for i <= n, k_i = H(u, x_i u, w); flagged iff every
//            k_i XOR c_i = 1.
//
// For the true recipient x_i u = r h_i and mG + yu = zG, so every bit is 1. For anyone else each
// bit is 1 with probability one half. H takes the x-coordinate of the shared point; the per-key
// products go through OpenSSL's ECDH (node:crypto), which returns that coordinate, and the one
// point the Chameleon hash needs per flag through @noble/curves.
import { createECDH } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha2'

const P = secp256k1.ProjectivePoint
const q = secp256k1.CURVE.n
export const GAMMA = 24
const utf8 = (s: string) => new TextEncoder().encode(s)
const DS_H = utf8('exp-e2e-frames/18/fmd/H')
const DS_G = utf8('exp-e2e-frames/18/fmd/G')
const cat = (...p: Uint8Array[]) => Buffer.concat(p.map((x) => Buffer.from(x)))
const be32 = (x: bigint) => Buffer.from(x.toString(16).padStart(64, '0'), 'hex')
const big = (b: Uint8Array) => BigInt(`0x${Buffer.from(b).toString('hex')}`)
const modq = (x: bigint) => ((x % q) + q) % q
function inv(a: bigint): bigint {
  let [r, nr, t, nt] = [q, modq(a), 0n, 1n]
  while (nr) { const k = r / nr; [r, nr] = [nr, r - k * nr]; [t, nt] = [nt, t - k * nt] }
  if (r !== 1n) throw new Error('not invertible')
  return modq(t)
}

export type SecretKey = bigint[]
export type PublicKey = Uint8Array[]
export type Flag = { u: Uint8Array; y: bigint; c: number[] }

/** A scalar in [1, q) from 32 random bytes; draws again in the rare case it falls outside. */
export function scalar(rnd: () => Uint8Array): bigint {
  for (;;) { const x = big(rnd()); if (x > 0n && x < q) return x }
}

export function keygen(rnd: () => Uint8Array): { sk: SecretKey; pk: PublicKey } {
  const sk = Array.from({ length: GAMMA }, () => scalar(rnd))
  return { sk, pk: sk.map(baseOf) }
}

/** x(k P) for any P, through OpenSSL: one context per scalar, reused for every point. */
function ecdhOf(k: bigint) {
  const e = createECDH('secp256k1')
  e.setPrivateKey(be32(k))
  return (point: Uint8Array) => e.computeSecret(Buffer.from(point))
}
/** kG, compressed, through OpenSSL. */
function baseOf(k: bigint): Uint8Array {
  const e = createECDH('secp256k1')
  e.setPrivateKey(be32(k))
  return e.getPublicKey(null, 'compressed')
}
const bitH = (u: Uint8Array, shared: Uint8Array, w: Uint8Array) => sha256(cat(DS_H, u, shared, w))[0] & 1
const scalarG = (u: Uint8Array, c: number[]) => modq(big(sha256(cat(DS_G, u, Uint8Array.from(c)))))

export function flag(pk: PublicKey, rnd: () => Uint8Array): Flag {
  const r = scalar(rnd)
  const z = scalar(rnd)
  const u = baseOf(r)
  const w = baseOf(z)
  const shared = ecdhOf(r)
  const c = pk.map((h) => bitH(u, shared(h), w) ^ 1)
  const m = scalarG(u, c)
  return { u, y: modq((z - m) * inv(r)), c }
}

/** The detection key: the first n of the secret keys, with an OpenSSL context for each. */
export type DetectionKey = { x: bigint[]; shared: ((point: Uint8Array) => Buffer)[] }
export const extract = (sk: SecretKey, n: number): DetectionKey => ({ x: sk.slice(0, n), shared: sk.slice(0, n).map(ecdhOf) })

/** The Chameleon hash's point, once per flag: mG + yu. */
export function wOf(f: Flag): Uint8Array {
  const m = scalarG(f.u, f.c)
  let pt = P.fromHex(f.u).multiplyUnsafe(f.y)
  if (m) pt = pt.add(P.BASE.multiply(m))
  return pt.toRawBytes(true)
}

/** Test with a detection key; `w` from wOf may be passed in when one flag is tested twice. */
export function test(dsk: DetectionKey, f: Flag, w = wOf(f)): boolean {
  for (let i = 0; i < dsk.x.length; i++) {
    if ((bitH(f.u, dsk.shared[i](f.u), w) ^ f.c[i]) !== 1) return false
  }
  return true
}

/** A flag as bytes: u (33) || y (32) || c (3, 24 bits). */
export function flagBytes(f: Flag): Uint8Array {
  const bits = new Uint8Array(3)
  f.c.forEach((b, i) => { if (b) bits[i >> 3] |= 1 << (i & 7) })
  return cat(f.u, be32(f.y), bits)
}
export function flagFrom(b: Uint8Array): Flag {
  if (b.length !== 68) throw new Error('a flag is 68 bytes')
  const c = Array.from({ length: GAMMA }, (_, i) => (b[65 + (i >> 3)] >> (i & 7)) & 1)
  return { u: b.subarray(0, 33), y: big(b.subarray(33, 65)), c }
}
