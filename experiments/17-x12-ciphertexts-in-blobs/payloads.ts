// Experiment 17 (X12): the two payloads a blob carries.
//
// S is an ERC-8441 schemeId 3 announcement, Sections 1 and 2 of the specification as written:
// a fresh secp256k1 ephemeral key and an ML-KEM-768 encapsulation, combined by SHA3-256 into the
// payment secret `ss`, from which the view tag and the stealth address follow. In a blob it travels
// as stealthAddress(20) || epk(33) || ct(1088) || view_tag(1), because ERC-5564 carries the address
// as an indexed topic of its event and a blob has no topics.
//
// N is this experiment's own note encryption, ML-KEM-768 only: the note's opening value(32) || r(32)
// sealed with ChaCha20-Poly1305 under a key derived from the encapsulated secret, as
// view_tag(1) || ct(1088) || sealed(80).
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { secp256k1 } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha2'
import { keccak_256, sha3_256 } from '@noble/hashes/sha3'
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js'

const utf8 = (s: string) => new TextEncoder().encode(s)
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])
const big = (b: Uint8Array) => BigInt(`0x${Buffer.from(b).toString('hex') || '0'}`)
const N_ORDER = secp256k1.CURVE.n
const validScalar = (b: Uint8Array) => b.length === 32 && big(b) > 0n && big(b) < N_ORDER

export const S_BYTES = 1142
export const N_BYTES = 1169
export const CT_BYTES = 1088

// ---- ERC-8441, Section 1 ----

const DS_OFFSET = utf8('pq-stealth/offset/v1')
const DS_VIEW_TAG = utf8('pq-stealth/view-tag/v1')
const DS_HYBRID = utf8('pq-stealth/hybrid-payment/v1')

/** H(ss): SHA256 of the offset separator and ss, range-checked, never reduced. */
export function offsetOf(ss: Uint8Array): bigint {
  const v = big(sha256(cat(DS_OFFSET, ss)))
  if (v === 0n || v >= N_ORDER) throw new Error('H(ss) out of range')
  return v
}
export const viewTagOf = (ss: Uint8Array) => sha256(cat(DS_VIEW_TAG, ss))[0]

/** Section 1.1: SHA3-256(DS || ss_ec || ss_pq || epk || ct || viewing_pk_ec || ek). */
export const hybridCombine = (ssEc: Uint8Array, ssPq: Uint8Array, epk: Uint8Array, ct: Uint8Array, viewingPk: Uint8Array, ek: Uint8Array) =>
  sha3_256(cat(DS_HYBRID, ssEc, ssPq, epk, ct, viewingPk, ek))

/** ECDH(k, P).x: the 32-byte x-coordinate alone. */
export const ecdhX = (k: Uint8Array, p: Uint8Array) => secp256k1.getSharedSecret(k, p, true).slice(1)

export function addressOf(pk: Uint8Array): Uint8Array {
  const u = secp256k1.ProjectivePoint.fromHex(pk).toRawBytes(false)
  return keccak_256(u.slice(1)).slice(12)
}
export function stealthPkOf(spendingPk: Uint8Array, ss: Uint8Array): Uint8Array {
  const p = secp256k1.ProjectivePoint.fromHex(spendingPk).add(secp256k1.ProjectivePoint.BASE.multiply(offsetOf(ss)))
  return p.toRawBytes(true)
}

// ---- ERC-8441, Section 2 ----

export type Recipient = { meta: Uint8Array; spendingPk: Uint8Array; viewingPk: Uint8Array; ek: Uint8Array }
export type Tracking = { viewingEc: Uint8Array; dk: Uint8Array; recipient: Recipient }

/** Section 2.1: a 128-byte seed to the meta-address, the tracking key and the master key. */
export function keygen(seed: Uint8Array): { recipient: Recipient; tracking: Tracking; master: Uint8Array } {
  if (seed.length !== 128) throw new Error('the seed is 128 bytes')
  const spendingSk = seed.slice(0, 32)
  const viewingEc = seed.slice(32, 64)
  const kemSeed = seed.slice(64, 128)
  if (!validScalar(spendingSk) || !validScalar(viewingEc)) throw new Error('not a valid scalar')
  if (eq(spendingSk, viewingEc) || eq(spendingSk, kemSeed.slice(0, 32)) || eq(spendingSk, kemSeed.slice(32))) throw new Error('a component repeats the spending seed')
  const { publicKey: ek, secretKey: dk } = ml_kem768.keygen(kemSeed)
  const spendingPk = secp256k1.getPublicKey(spendingSk, true)
  const viewingPk = secp256k1.getPublicKey(viewingEc, true)
  const recipient = { meta: cat(spendingPk, viewingPk, ek), spendingPk, viewingPk, ek }
  return { recipient, tracking: { viewingEc, dk, recipient }, master: spendingSk }
}

/** Section 2.4, with the sender's randomness passed in so a run can repeat it. */
export function announce(r: Recipient, esk: Uint8Array, m: Uint8Array) {
  if (!validScalar(esk)) throw new Error('esk is not a valid scalar')
  const epk = secp256k1.getPublicKey(esk, true)
  const ssEc = ecdhX(esk, r.viewingPk)
  const { cipherText: ct, sharedSecret: ssPq } = ml_kem768.encapsulate(r.ek, m)
  const ss = hybridCombine(ssEc, ssPq, epk, ct, r.viewingPk, r.ek)
  const stealthAddress = addressOf(stealthPkOf(r.spendingPk, ss))
  return { stealthAddress, epk, ct, viewTag: viewTagOf(ss), ss }
}

/** The blob entry: stealthAddress || epk || ct || view_tag. */
export const encodeS = (a: { stealthAddress: Uint8Array; epk: Uint8Array; ct: Uint8Array; viewTag: number }) =>
  cat(a.stealthAddress, a.epk, a.ct, Uint8Array.of(a.viewTag))

/**
 * Section 2.5, over one blob entry: ECDH, decapsulation and the combiner always; the offset, the
 * point arithmetic and the address only on a view-tag match. Returns ss on a match.
 */
export function scanS(t: Tracking, entry: Uint8Array): Uint8Array | undefined {
  if (entry.length !== S_BYTES) return undefined
  const stealthAddress = entry.subarray(0, 20)
  const epk = entry.subarray(20, 53)
  const ct = entry.subarray(53, 1141)
  let ssEc: Uint8Array
  try { ssEc = ecdhX(t.viewingEc, epk) } catch { return undefined } // not a point: a skip (2.7)
  const ssPq = ml_kem768.decapsulate(ct, t.dk)
  const ss = hybridCombine(ssEc, ssPq, epk, ct, t.recipient.viewingPk, t.recipient.ek)
  if (viewTagOf(ss) !== entry[1141]) return undefined
  let a: Uint8Array
  try { a = addressOf(stealthPkOf(t.recipient.spendingPk, ss)) } catch { return undefined }
  return eq(a, stealthAddress) ? ss : undefined
}

// ---- S2, run 2: an announcement that carries ERC-5564's metadata ----

/** ERC-5564's recommended metadata: view tag (1) || function selector (4) || token (20) || amount (32). */
export const META_BYTES = 57
/** stealthAddress (20) || epk (33) || ct (1088) || len (1) || metadata (len), with len = 57 in run 2. */
export const S2_BYTES = 20 + 33 + CT_BYTES + 1 + META_BYTES
export const metadataOf = (viewTag: number, selector: Uint8Array, token: Uint8Array, amount: Uint8Array) => {
  if (selector.length !== 4 || token.length !== 20 || amount.length !== 32) throw new Error('selector 4, token 20, amount 32')
  return cat(Uint8Array.of(viewTag), selector, token, amount)
}
export const encodeS2 = (a: { stealthAddress: Uint8Array; epk: Uint8Array; ct: Uint8Array }, metadata: Uint8Array) => {
  if (metadata.length === 0 || metadata.length > 255) throw new Error('metadata of 1 to 255 bytes')
  return cat(a.stealthAddress, a.epk, a.ct, Uint8Array.of(metadata.length), metadata)
}
export function decodeS2(entry: Uint8Array) {
  if (entry.length < 20 + 33 + CT_BYTES + 2) return undefined
  const len = entry[1141]
  if (len === 0 || entry.length !== 1142 + len) return undefined
  return { stealthAddress: entry.subarray(0, 20), epk: entry.subarray(20, 53), ct: entry.subarray(53, 1141), metadata: entry.subarray(1142) }
}
/** The same scan as scanS, with the view tag taken from the metadata's first byte. */
export function scanS2(t: Tracking, entry: Uint8Array): Uint8Array | undefined {
  const d = decodeS2(entry)
  return d ? scanS(t, cat(d.stealthAddress, d.epk, d.ct, d.metadata.subarray(0, 1))) : undefined
}

// ---- N: an encrypted note ----

const DS_NOTE_TAG = utf8('exp-e2e-frames/17/note-view-tag')
const DS_NOTE_KEY = utf8('exp-e2e-frames/17/note-key')
const ZERO_NONCE = new Uint8Array(12)

export function noteKeygen(seed: Uint8Array) {
  if (seed.length !== 64) throw new Error('the note seed is 64 bytes')
  const { publicKey: ek, secretKey: dk } = ml_kem768.keygen(seed)
  return { ek, dk }
}

/** view_tag || ct || ChaCha20-Poly1305(key, 0, value || r). */
export function sealNote(ek: Uint8Array, opening: Uint8Array, m: Uint8Array): Uint8Array {
  if (opening.length !== 64) throw new Error('the opening is value(32) || r(32)')
  const { cipherText: ct, sharedSecret: ss } = ml_kem768.encapsulate(ek, m)
  const key = sha3_256(cat(DS_NOTE_KEY, ss, ct))
  const sealed = chacha20poly1305(key, ZERO_NONCE).encrypt(opening)
  return cat(Uint8Array.of(sha256(cat(DS_NOTE_TAG, ss))[0]), ct, sealed)
}

/** Decapsulate, compare the view tag, then open; the AEAD tag decides. */
export function scanN(dk: Uint8Array, entry: Uint8Array): Uint8Array | undefined {
  if (entry.length !== N_BYTES) return undefined
  const ct = entry.subarray(1, 1089)
  const ss = ml_kem768.decapsulate(ct, dk)
  if (sha256(cat(DS_NOTE_TAG, ss))[0] !== entry[0]) return undefined
  try {
    return chacha20poly1305(sha3_256(cat(DS_NOTE_KEY, ss, ct)), ZERO_NONCE).decrypt(entry.subarray(1089))
  } catch {
    return undefined
  }
}

export { cat, eq }
