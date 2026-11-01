// Experiment 17 (X12): one blob of entries, its KZG commitment, and openings the chain can check.
//
// A blob is 4,096 field elements of 32 bytes. Each element here carries 31 bytes under a zero high
// byte, so it is always below the BLS12-381 scalar modulus.
//   element 0          header: 0x00 || version(1) || kind(1) || count(2) || entryLen(2) || zeros
//   elements 1..count  one per entry: 0x00 || keccak256(entry)[0..31]
//   then the entries, each from a fresh element, 31 bytes per element
// Element i is the blob polynomial's value at the i-th root of unity in bit-reversed order
// (EIP-4844; the consensus specification's PRIMITIVE_ROOT_OF_UNITY 7), so one point evaluation at
// that root proves one element: the header, or one entry's hash.
import kzg from 'c-kzg'
import { keccak_256 } from '@noble/hashes/sha3'
import { type Hex, bytesToHex, concatHex, fromRlp, hexToBytes, sha256, toRlp } from 'viem'
import { type FrameTx, encodePayload } from '../../src/exp-frames/frametx/index.js'

kzg.loadTrustedSetup(0)

export const FIELD_ELEMENTS = 4096
export const BYTES_PER_BLOB = 32 * FIELD_ELEMENTS
export const BLOB_GAS = 131_072
export const BLS_MODULUS = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n
export const VERSION = 1
export const KIND = { S: 1, N: 2 } as const
export type Kind = (typeof KIND)[keyof typeof KIND]

const elementsFor = (len: number) => Math.ceil(len / 31)
/** Entries of `len` bytes that fit one blob, with a header and one hash slot each. */
export const capacity = (len: number) => Math.floor((FIELD_ELEMENTS - 1) / (1 + elementsFor(len)))

export function headerOf(kind: Kind, count: number, len: number): Uint8Array {
  const h = new Uint8Array(32)
  h[1] = VERSION
  h[2] = kind
  h[3] = count >> 8
  h[4] = count & 0xff
  h[5] = len >> 8
  h[6] = len & 0xff
  return h
}
/** An entry's hash slot: 0x00 || keccak256(entry)[0..31]. */
export const slotOf = (entry: Uint8Array) => Uint8Array.of(0, ...keccak_256(entry).slice(0, 31))

export function packBlob(kind: Kind, entries: Uint8Array[]): Uint8Array {
  const len = entries[0]?.length ?? 0
  if (entries.length === 0 || entries.some((e) => e.length !== len)) throw new Error('entries of one length')
  if (entries.length > capacity(len)) throw new Error(`${entries.length} entries; a blob holds ${capacity(len)}`)
  const blob = new Uint8Array(BYTES_PER_BLOB)
  blob.set(headerOf(kind, entries.length, len), 0)
  entries.forEach((e, i) => blob.set(slotOf(e), 32 * (1 + i)))
  const per = elementsFor(len)
  entries.forEach((e, i) => {
    const first = 1 + entries.length + i * per
    for (let k = 0; k < per; k++) blob.set(e.subarray(31 * k, Math.min(31 * k + 31, len)), 32 * (first + k) + 1)
  })
  return blob
}

/** The entries back, each checked against its hash slot. */
export function unpackBlob(blob: Uint8Array): { kind: number; entries: Uint8Array[] } {
  if (blob[0] !== 0 || blob[1] !== VERSION) throw new Error('not a version 1 blob')
  const kind = blob[2]
  const count = (blob[3] << 8) | blob[4]
  const len = (blob[5] << 8) | blob[6]
  const per = elementsFor(len)
  const entries: Uint8Array[] = []
  for (let i = 0; i < count; i++) {
    const e = new Uint8Array(len)
    const first = 1 + count + i * per
    for (let k = 0; k < per; k++) e.set(blob.subarray(32 * (first + k) + 1, 32 * (first + k) + 1 + Math.min(31, len - 31 * k)), 31 * k)
    const slot = blob.subarray(32 * (1 + i), 32 * (2 + i))
    if (!slotOf(e).every((x, j) => x === slot[j])) throw new Error(`entry ${i} does not match its hash slot`)
    entries.push(e)
  }
  return { kind, entries }
}

export const element = (blob: Uint8Array, i: number) => blob.slice(32 * i, 32 * (i + 1))

// ---- KZG ----

export const commitmentOf = (blob: Uint8Array) => kzg.blobToKzgCommitment(blob)
/** EIP-4844: 0x01 || sha256(commitment)[1..32]. */
export const versionedHashOf = (commitment: Uint8Array): Hex => `0x01${sha256(commitment).slice(4)}` as Hex
export const cellProofsOf = (blob: Uint8Array) => kzg.computeCellsAndKzgProofs(blob)[1]

const modpow = (b: bigint, e: bigint, m: bigint) => {
  let r = 1n
  b %= m
  for (; e > 0n; e >>= 1n, b = (b * b) % m) if (e & 1n) r = (r * b) % m
  return r
}
/** The primitive 4,096-th root of unity: 7^((r - 1) / 4096). */
export const OMEGA = modpow(7n, (BLS_MODULUS - 1n) / BigInt(FIELD_ELEMENTS), BLS_MODULUS)
/** The 12-bit bit reversal. */
export const brp = (i: number) => {
  let r = 0
  for (let b = 0; b < 12; b++) r |= ((i >> b) & 1) << (11 - b)
  return r
}
/** The evaluation point of element i. */
export const domainPoint = (i: number) => modpow(OMEGA, BigInt(brp(i)), BLS_MODULUS)

const word = (x: bigint) => hexToBytes(`0x${x.toString(16).padStart(64, '0')}`)

/** An opening at any point z: what an archiver answers a challenge with. */
export function openAt(blob: Uint8Array, z: bigint) {
  const [proof, y] = kzg.computeKzgProof(blob, word(z))
  return { proof, y }
}
/** An opening of element i, at its domain point. */
export const openElement = (blob: Uint8Array, i: number) => openAt(blob, domainPoint(i))

/** The point-evaluation precompile's input: versioned_hash || z || y || commitment || proof. */
export const precompileInput = (vh: Hex, z: bigint, y: Uint8Array, commitment: Uint8Array, proof: Uint8Array): Hex =>
  concatHex([vh, bytesToHex(word(z)), bytesToHex(y), bytesToHex(commitment), bytesToHex(proof)])

/** Off chain, what the precompile checks. */
export const verifyOpening = (commitment: Uint8Array, z: bigint, y: Uint8Array, proof: Uint8Array) => kzg.verifyKzgProof(commitment, word(z), y, proof)

// ---- the network form of a blob-carrying transaction (EIP-7594, wrapper version 1) ----

export type Sidecar = { blobs: Uint8Array[]; commitments: Uint8Array[]; cellProofs: Uint8Array[] }
export function sidecarOf(blobs: Uint8Array[]): Sidecar {
  return { blobs, commitments: blobs.map(commitmentOf), cellProofs: blobs.flatMap(cellProofsOf) }
}
const hexes = (xs: Uint8Array[]) => xs.map((x) => bytesToHex(x))
const sidecarFields = (s: Sidecar) => [hexes(s.blobs), hexes(s.commitments), hexes(s.cellProofs)]

/** EIP-8141: a frame transaction with blobs travels as 0x06 || rlp([payload, 1, blobs, commitments, cell_proofs]). */
export function frameTxWithBlobs(tx: FrameTx, s: Sidecar): Hex {
  const payload = fromRlp(encodePayload(tx), 'hex')
  return concatHex(['0x06', toRlp([payload, '0x01', ...sidecarFields(s)] as never)])
}

/** EIP-4844 with EIP-7594's wrapper: 0x03 || rlp([payload, 1, blobs, commitments, cell_proofs]), from a signed payload. */
export function blobTxWithBlobs(signedPayload: Hex, s: Sidecar): Hex {
  if (!signedPayload.startsWith('0x03')) throw new Error('not a type-3 payload')
  const payload = fromRlp(`0x${signedPayload.slice(4)}`, 'hex')
  return concatHex(['0x03', toRlp([payload, '0x01', ...sidecarFields(s)] as never)])
}
