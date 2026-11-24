// Experiment 27 (X20): what the parties do off chain. It covers sealing a payload to a directory
// key or under a pair's or a document's secret, the announcement's tag, packing envelopes into a
// blob, and the board's transactions.
//
// Every hash is keccak256 over 32-byte words. ML-KEM-768 and AES-256-GCM are @noble/post-quantum's
// and Node's, as experiment 26 uses them.
import { createCipheriv, createDecipheriv } from 'node:crypto'
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js'
import { type Address, type Hex, bytesToHex, concatHex, hexToBytes, keccak256, pad, toHex } from 'viem'
import { Approve, type Frame, type FrameTx, STORAGE_SET_STATE_GAS, senderFrame, verifyFrame } from '../../src/exp-frames/frametx/index.js'
import * as B from '../17-x12-ciphertexts-in-blobs/blob.js'
import * as X14 from '../19-x14-hash-based-stealth-addresses-under-8288/x14.js'

export const BOARD = '0x0000000000000000000000000000000000020020' as Address
export const SEL = { setKey: '0x3701294c', post: '0x05c1f502', redeem: '0xbe040fb0' } as const
export const TOPIC = {
  KeySet: '0x4be471d942b571edad2d1841c69493f8442908a01bcc5337d7be2d32ff8e2c52',
  Announce: '0x8e76e31d2014d4b460431883aaf880cfb2ca1e6c5716ce037c234aeb840710ab',
  Redeemed: '0x61d905e697374527439f5c64f060ae521e3b586e8f61ef3f160057e7150e153e',
} as const
/** Announcement kinds: first contact, a pair's tag, a document's tag. */
export const KIND = { FIRST: 0, PAIR: 1, DOC: 2 } as const
export const PLAIN_BYTES = 1024
export const FIRST_BYTES = 1088 + 12 + 16 + PLAIN_BYTES
export const TAGGED_BYTES = 12 + 16 + PLAIN_BYTES

export const word = (x: bigint | number): Hex => pad(toHex(BigInt(x)), { size: 32 })
const tagWord = (s: string): Hex => word(BigInt(`0x${Buffer.from(s).toString('hex')}`))
export const H = (...ws: Hex[]): Hex => keccak256(concatHex(ws))
export const mapslot = (key: Hex, tag: number): Hex => H(key, word(tag))

// ---- keys ----

/** A party's ML-KEM-768 key pair at a version, from its seed alone. */
export function kemKeys(seed: Uint8Array, version: number) {
  const half = (i: number) => hexToBytes(keccak256(concatHex([bytesToHex(seed), toHex(`exp-e2e-frames/27/kem/${version}/${i}`)])))
  return ml_kem768.keygen(new Uint8Array([...half(0), ...half(1)]))
}

// ---- sealing ----

const pad1024 = (plain: string) => {
  const b = Buffer.alloc(PLAIN_BYTES, 0x20)
  if (Buffer.byteLength(plain) > PLAIN_BYTES) throw new Error('the payload does not fit its size class')
  b.write(plain)
  return b
}
function gcmSeal(key: Uint8Array, plain: string): Uint8Array {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const c = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(pad1024(plain)), c.final()])
  return new Uint8Array([...iv, ...c.getAuthTag(), ...ct])
}
function gcmOpen(key: Uint8Array, env: Uint8Array): string | null {
  try {
    const d = createDecipheriv('aes-256-gcm', key, env.slice(0, 12))
    d.setAuthTag(env.slice(12, 28))
    return Buffer.concat([d.update(env.slice(28)), d.final()]).toString('utf8').trim()
  } catch { return null }
}
const keyOf = (secret: Hex, label: string, i: number) => hexToBytes(H(secret, tagWord(label), word(i)))

/** First contact: sealed to the recipient's directory key. The sender keeps `ss` for the pair. */
export function sealFirst(recipientKem: Uint8Array, plain: string): { env: Uint8Array; ss: Hex } {
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(recipientKem)
  const ss = bytesToHex(sharedSecret) as Hex
  return { env: new Uint8Array([...cipherText, ...gcmSeal(keyOf(ss, 'x20/key', 0), plain)]), ss }
}
export function openFirst(secretKey: Uint8Array, env: Uint8Array): { plain: string; ss: Hex } | null {
  if (env.length !== FIRST_BYTES) return null
  try {
    const ss = bytesToHex(ml_kem768.decapsulate(env.slice(0, 1088), secretKey)) as Hex
    const plain = gcmOpen(keyOf(ss, 'x20/key', 0), env.slice(1088))
    return plain === null ? null : { plain, ss }
  } catch { return null }
}
/** After first contact, message i of a pair, and its announcement's tag. */
export const pairTag = (ss: Hex, i: number): Hex => H(ss, tagWord('x20/tag'), word(i))
export const sealPair = (ss: Hex, i: number, plain: string) => gcmSeal(keyOf(ss, 'x20/key', i), plain)
export const openPair = (ss: Hex, i: number, env: Uint8Array) => gcmOpen(keyOf(ss, 'x20/key', i), env)
/** A document's checkpoint `seq`, under its key, and its tag. */
export const docTag = (docKey: Hex, seq: number): Hex => H(docKey, tagWord('x20/doc'), word(seq))
export const sealDoc = (docKey: Hex, seq: number, plain: string) => gcmSeal(keyOf(docKey, 'x20/docKey', seq), plain)
export const openDoc = (docKey: Hex, seq: number, env: Uint8Array) => gcmOpen(keyOf(docKey, 'x20/docKey', seq), env)

// ---- blobs: envelopes end to end, 31 bytes to each field element ----

export function packBlob(envs: Uint8Array[]): { blob: Uint8Array; offsets: number[] } {
  const offsets: number[] = []
  let total = 0
  for (const e of envs) { offsets.push(total); total += e.length }
  const stream = new Uint8Array(total)
  envs.forEach((e, i) => stream.set(e, offsets[i]))
  if (Math.ceil(total / 31) > B.FIELD_ELEMENTS) throw new Error('the envelopes do not fit one blob')
  const blob = new Uint8Array(B.BYTES_PER_BLOB)
  for (let k = 0; 31 * k < total; k++) blob.set(stream.subarray(31 * k, Math.min(31 * k + 31, total)), 32 * k + 1)
  return { blob, offsets }
}
export function readBlob(blob: Uint8Array, offset: number, length: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let j = 0; j < length; j++) {
    const p = offset + j
    out[j] = blob[32 * Math.floor(p / 31) + 1 + (p % 31)]
  }
  return out
}

// ---- the board's transactions ----

export const LIMITS = { verify: 60_000n, sender: 200_000n, senderState: 600_000n }
function tx(chainId: bigint, nonceKey: Hex, triples: Hex, data: Hex, blobs: Hex[] = []): FrameTx {
  const frames: Frame[] = [
    verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, execution: LIMITS.verify, state: STORAGE_SET_STATE_GAS }),
    X14.depFrame(triples),
    senderFrame({ target: BOARD, data, execution: LIMITS.sender, state: LIMITS.senderState }),
  ]
  return { chainId, nonceKeys: [BigInt(nonceKey)], nonceSeq: 0n, sender: BOARD, frames, signatures: [], fees: blobs.length ? { ...X14.FEES, maxFeePerBlobGas: 100n } : X14.FEES, blobVersionedHashes: blobs }
}

export const dirMessage = (key: Hex, kemKey: Uint8Array, version: number): Hex =>
  H(tagWord('x20/dir'), pad(BOARD, { size: 32 }), key, keccak256(kemKey), word(version))
export function setKeyTx(chainId: bigint, key: Hex, version: number, kemKey: Uint8Array, signingKey: Hex = key): FrameTx {
  const triples = X14.triple(X14.LEANSPHINCS_SCHEME, dirMessage(key, kemKey, version), signingKey)
  return tx(chainId, H(tagWord('x20/dir'), key, word(version)), triples, concatHex([SEL.setKey as Hex, key, word(version), bytesToHex(kemKey)]))
}

export type Entry = { senderKey: Hex; env: Uint8Array; kind: number; tag: Hex; fee: bigint }
export const postMessage = (envHash: Hex, fee: bigint, relayTo: Address, carrier: number): Hex =>
  H(tagWord('x20/post'), pad(BOARD, { size: 32 }), envHash, word(fee), pad(relayTo, { size: 32 }), word(carrier))
/** A post of entries, as a relay packs them (carrier 0, one blob) or a sender posts its own (carrier 1). */
export function postTx(chainId: bigint, entries: Entry[], relayTo: Address, carrier: 0 | 1) {
  const envs = entries.map((e) => e.env)
  const packed = carrier === 0 ? packBlob(envs) : null
  const offsets = packed ? packed.offsets : (() => { const o: number[] = []; let t = 0; for (const e of envs) { o.push(t); t += e.length } return o })()
  const rows = entries.map((e, i) => concatHex([e.senderKey, keccak256(e.env), word(offsets[i]), word(e.env.length), word(e.fee), word(e.kind), e.tag]))
  const head = concatHex([SEL.post as Hex, pad(relayTo, { size: 32 }), word(carrier), word(entries.length)])
  const data = carrier === 1 ? concatHex([head, ...rows, ...envs.map((e) => bytesToHex(e))]) : concatHex([head, ...rows])
  const triples = concatHex(entries.map((e) => X14.triple(X14.LEANSPHINCS_SCHEME, postMessage(keccak256(e.env), e.fee, relayTo, carrier), e.senderKey)))
  const sidecar = packed ? B.sidecarOf([packed.blob]) : null
  const vhs = sidecar ? sidecar.commitments.map(B.versionedHashOf) : []
  const t = tx(chainId, H(tagWord('x20/post'), keccak256(entries[0].env)), triples, data, vhs)
  return { tx: t, sidecar, blob: packed?.blob ?? null, offsets, versionedHash: vhs[0] ?? null }
}

export const redeemMessage = (vh: Hex, archiver: Address, fee: bigint, nonce: number): Hex =>
  H(tagWord('x20/fetch'), pad(BOARD, { size: 32 }), vh, pad(archiver, { size: 32 }), word(fee), word(nonce))
export function redeemTx(chainId: bigint, recipientKey: Hex, archiver: Address, vh: Hex, fee: bigint, nonce: number): FrameTx {
  const triples = X14.triple(X14.LEANSPHINCS_SCHEME, redeemMessage(vh, archiver, fee, nonce), recipientKey)
  const data = concatHex([SEL.redeem as Hex, recipientKey, pad(archiver, { size: 32 }), vh, word(fee), word(nonce)])
  return tx(chainId, H(tagWord('x20/fetch'), recipientKey, vh, word(nonce)), triples, data)
}

/** The most a transaction can cost: every limit and an allowance for the intrinsic cost. */
export function maxCostOf(t: FrameTx, intrinsic = 200_000n): bigint {
  const limits = t.frames.reduce((a, f) => a + f.limits.execution + f.limits.state, 0n)
  return (limits + intrinsic) * t.fees.maxFeePerGas + (t.blobVersionedHashes.length ? BigInt(B.BLOB_GAS) * t.fees.maxFeePerBlobGas : 0n)
}
