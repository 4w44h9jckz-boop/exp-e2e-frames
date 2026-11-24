// Experiment 18 (X13): the note, its opening, and how the opening travels.
//
// A note commits to its delivery (circuits/deliver.circom):
//   owner = H(pkR, d), c = H(value, owner, n, s, h, T, refund), leaf = H(c, t0), nullifier = H(n).
// The opening is value(32) || n(32) || s(32) || T(8) || refund(32), 136 bytes.
//
// First contact seals it as experiment 17's encrypted note, with ML-KEM-768:
//   entry = view_tag(1) || ct(1088) || sealed(152), 1,241 bytes,
//   view_tag = SHA256(DS_TAG || ss)[0], key = SHA3-256(DS_KEY || ss || ct),
//   sealed = ChaCha20-Poly1305(key, zero nonce, opening).
// After first contact, note k travels under t_k = keccak256(DS_PAIR_TAG || ss || k) and is sealed
// under keccak256(DS_PAIR_KEY || ss || k): 152 bytes, no encapsulation.
// h is keccak256 of the delivered bytes, reduced into BN254's scalar field.
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { sha256 } from '@noble/hashes/sha2'
import { keccak_256, sha3_256 } from '@noble/hashes/sha3'
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js'
import { FIELD, H } from '../15-x10-out-and-back/x10.js'

const utf8 = (s: string) => new TextEncoder().encode(s)
export const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
const be = (x: bigint, n: number) => {
  const out = new Uint8Array(n)
  for (let i = n - 1; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n }
  if (x) throw new Error(`does not fit ${n} bytes`)
  return out
}
const big = (b: Uint8Array) => BigInt(`0x${Buffer.from(b).toString('hex') || '0'}`)

export const DENOM = 10n ** 15n
export const OPENING_BYTES = 136
export const SEALED_BYTES = OPENING_BYTES + 16
export const ENTRY_BYTES = 1 + 1088 + SEALED_BYTES

const DS_TAG = utf8('exp-e2e-frames/18/view-tag')
const DS_KEY = utf8('exp-e2e-frames/18/key')
const DS_PAIR_TAG = utf8('exp-e2e-frames/18/pair-tag')
const DS_PAIR_KEY = utf8('exp-e2e-frames/18/pair-key')
const ZERO_NONCE = new Uint8Array(12)

// ---- the note ----

export type Opening = { value: bigint; n: bigint; s: bigint; T: bigint; refund: bigint }
export type Recipient = { pkR: bigint; d: bigint }
export const ownerOf = (r: Recipient) => H(r.pkR, r.d)
/** h: keccak256 of the delivered bytes, in the field. */
export const hOf = (bytes: Uint8Array) => big(keccak_256(bytes)) % FIELD
export const commitmentOf = (o: Opening, r: Recipient, h: bigint) => H(o.value, ownerOf(r), o.n, o.s, h, o.T, o.refund)
export const leafOf = (c: bigint, t0: bigint) => H(c, t0)
export const nullifierOf = (o: Opening) => H(o.n)

export const encodeOpening = (o: Opening) => cat(be(o.value, 32), be(o.n, 32), be(o.s, 32), be(o.T, 8), be(o.refund, 32))
export function decodeOpening(b: Uint8Array): Opening {
  if (b.length !== OPENING_BYTES) throw new Error('an opening is 136 bytes')
  return { value: big(b.subarray(0, 32)), n: big(b.subarray(32, 64)), s: big(b.subarray(64, 96)), T: big(b.subarray(96, 104)), refund: big(b.subarray(104, 136)) }
}

// ---- first contact ----

export function kemKeygen(seed: Uint8Array) {
  if (seed.length !== 64) throw new Error('the KEM seed is 64 bytes')
  const { publicKey: ek, secretKey: dk } = ml_kem768.keygen(seed)
  return { ek, dk }
}

/** Seal an opening to `ek`: the 1,241-byte entry, and the shared secret for later notes. */
export function sealFirst(ek: Uint8Array, opening: Opening, m: Uint8Array) {
  const { cipherText: ct, sharedSecret: ss } = ml_kem768.encapsulate(ek, m)
  const key = sha3_256(cat(DS_KEY, ss, ct))
  const sealed = chacha20poly1305(key, ZERO_NONCE).encrypt(encodeOpening(opening))
  return { entry: cat(Uint8Array.of(sha256(cat(DS_TAG, ss))[0]), ct, sealed), ss }
}

/** Trial-decrypt one entry: the opening and the shared secret if it is ours. */
export function openFirst(dk: Uint8Array, entry: Uint8Array): { opening: Opening; ss: Uint8Array } | undefined {
  if (entry.length !== ENTRY_BYTES) return undefined
  const ct = entry.subarray(1, 1089)
  const ss = ml_kem768.decapsulate(ct, dk)
  if (sha256(cat(DS_TAG, ss))[0] !== entry[0]) return undefined
  try {
    const opening = chacha20poly1305(sha3_256(cat(DS_KEY, ss, ct)), ZERO_NONCE).decrypt(entry.subarray(1089))
    return { opening: decodeOpening(opening), ss }
  } catch {
    return undefined
  }
}

// ---- after first contact ----

export const pairTag = (ss: Uint8Array, k: number) => keccak_256(cat(DS_PAIR_TAG, ss, be(BigInt(k), 8)))
const pairKey = (ss: Uint8Array, k: number) => keccak_256(cat(DS_PAIR_KEY, ss, be(BigInt(k), 8)))
export const sealPair = (ss: Uint8Array, k: number, opening: Opening) => chacha20poly1305(pairKey(ss, k), ZERO_NONCE).encrypt(encodeOpening(opening))
export function openPair(ss: Uint8Array, k: number, sealed: Uint8Array): Opening | undefined {
  try {
    return decodeOpening(chacha20poly1305(pairKey(ss, k), ZERO_NONCE).decrypt(sealed))
  } catch {
    return undefined
  }
}
