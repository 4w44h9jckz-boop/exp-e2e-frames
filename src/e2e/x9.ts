// Experiment 14 (X9): the vault's layouts and the committee's formats in TypeScript, for the runner
// and as a second implementation the checks compare with the committee's Rust
// (committee/exit-committee).
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1'
import { type Hex, bytesToHex, concatHex, hexToBytes, keccak256, numberToHex, pad, slice } from 'viem'

export const VERSION = 0x02
export const INFO_OPENING = 'x9/opening'
export const INFO_INTENT = 'x9/intent'
export const INTENT_LEN = 116
export const OPENING_LEN = 99
export const OPENINGS_LEN = 3 * OPENING_LEN

/** Selectors of the vault's calls, and the packed SENDER data of its own frames. */
export const SELECTORS = {
  deposit: '0xb214faa5',
  withdraw: '0x21a0adb6',
  process: '0xdfefb7d7',
  reconcile: '0x8f0d7e35',
  enqueue: '0x84473fa8',
  claim: '0x1e83409a',
  republish: '0x8bb852fe',
  getLastRoot: '0xba70f757',
  nextIndex: '0xfc7e9c6f',
  owed: '0xdf18e047',
  sourceId: '0xd069aab9',
  mode: '0x295a5212',
  head: '0x8f7dcfa3',
  tail: '0x13d8c840',
  since: '0x3dc54b40',
  escapeAt: '0x1cde8331',
  spent: '0xae20bed3',
  knownRoot: '0xfe3c4713',
  moved: '0xd0582670',
  intentAt: '0x9de7ab90',
  redeemed: '0xe231bff0',
  committeeKey: '0x9be76a90',
  timeout: '0x70dea79a',
  escapeWindow: '0x3876c1e4',
} as const

/** Event topics the vault emits. */
export const TOPICS = {
  Deposit: '0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196',
  Withdrawal: '0xe9e508bad6d4c3227e881ca19068f099da81b5164dd6d62b2eaf1e8bc6c34931',
  FeeRefund: '0x32eb933bf48f87eb8469184574aaecf94ff754f8b092bb9d4b92d1fcddee9f1d',
  Intent: '0x903d4bf4fba0e73fd481f24eb864f1a3c1d845d01621067c9284ed74dd1118df',
  Opening: '0x72f73349d6f752014ce9d1c777432e0028288a3c56201abfc015b655a3aefc34',
  Escape: '0x92d79a61fe619b024b5d244cac3622b69ab51cb99c5ebdf37068768b22192fcb',
  Redeemed: '0x11673c127f647a39cbf39134f14445ebf13558f7ec53c37294dabb256868c48a',
  Reconciled: '0x0edd08e4305bd5ef9897d9d73c38c0f7408344921f6a78211d15e3183b7c9d0f',
  RecentRoot: '0x2fd31368794d8179a2869e743a7fb1d8819c4b52d4154ba95ddbba7cf39a8552',
} as const

/** The AAD of an intent or an opening: the vault's address and a 64-bit number. */
export const aad = (vault: Hex, n: number | bigint): Hex => concatHex([vault, numberToHex(BigInt(n), { size: 8 })])

function cipher(shared: Uint8Array, ephemeral: Uint8Array, info: string) {
  const okm = new Uint8Array(hkdfSync('sha256', shared, ephemeral, info, 44))
  return { key: okm.slice(0, 32), iv: okm.slice(32) }
}

/** Seals `plaintext` to the compressed secp256k1 key `to` (exp-frames 33's scheme, version 2). */
export function seal(to: Hex, plaintext: Hex, info: string, ad: Hex, ephemeral: Uint8Array = secp256k1.utils.randomPrivateKey()): Hex {
  const e = secp256k1.getPublicKey(ephemeral, true)
  const shared = secp256k1.getSharedSecret(ephemeral, hexToBytes(to), true).slice(1)
  const { key, iv } = cipher(shared, e, info)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(hexToBytes(ad))
  const body = Buffer.concat([c.update(hexToBytes(plaintext)), c.final(), c.getAuthTag()])
  return concatHex([numberToHex(VERSION, { size: 1 }), slice(keccak256(shared), 0, 1), bytesToHex(e), bytesToHex(body)])
}

/** Opens a sealed message with `secret`, or `undefined` if it is not for that key. */
export function open(secret: Hex, message: Hex, info: string, ad: Hex): Hex | undefined {
  const m = hexToBytes(message)
  if (m.length < 51 || m[0] !== VERSION) return undefined
  const e = m.slice(2, 35)
  let shared: Uint8Array
  try {
    shared = secp256k1.getSharedSecret(hexToBytes(secret), e, true).slice(1)
  } catch {
    return undefined
  }
  if (hexToBytes(keccak256(shared))[0] !== m[1]) return undefined
  const { key, iv } = cipher(shared, e, info)
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAAD(hexToBytes(ad))
  d.setAuthTag(m.slice(m.length - 16))
  try {
    return bytesToHex(Buffer.concat([d.update(m.slice(35, m.length - 16)), d.final()]))
  } catch {
    return undefined
  }
}

/** An opening's plaintext: part (31) || member (1) || leaf (u32) || update (u64) || 4 zero bytes. */
export function readOpening(p: Hex) {
  const b = hexToBytes(p)
  if (b.length !== 48 || b.slice(44).some((x) => x !== 0)) throw new Error('not an opening')
  const v = new DataView(b.buffer, b.byteOffset)
  return { part: bytesToHex(b.slice(0, 31)), member: b[31], leaf: v.getUint32(32), update: v.getBigUint64(36) }
}

/** The update's recipient: uint160(keccak256(vault (32) || intent hash || C || keccak256(openings))). */
export const recipient = (vault: Hex, intentHash: Hex, c: Hex, openings: Hex): Hex =>
  pad(slice(keccak256(concatHex([pad(vault), intentHash, pad(c), keccak256(openings)])), 12), { size: 32 })

/** Reconciliation's list of redemptions, strictly ascending, and its digest keccak256(list). */
export function redemptionList(nullifierHashes: Hex[]): { list: Hex[]; digest: Hex } {
  const list = [...new Set(nullifierHashes.map((h) => h.toLowerCase() as Hex))].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
  return { list, digest: keccak256(concatHex(list)) }
}

/** The reconciliation's only nonce key: keccak256("X9_RECONCILE" || escapeAt (32)). */
export const reconcileNonceKey = (escapeAt: number | bigint): Hex =>
  keccak256(concatHex([bytesToHex(new TextEncoder().encode('X9_RECONCILE')), numberToHex(BigInt(escapeAt), { size: 32 })]))

/** What the committee signs to reconcile: chain_id || vault || escapeAt || digest. */
export const reconcileMessage = (chainId: number, vault: Hex, escapeAt: number | bigint, digest: Hex): Hex =>
  concatHex([numberToHex(chainId, { size: 32 }), pad(vault), numberToHex(BigInt(escapeAt), { size: 32 }), digest])

/** enqueue(bytes) calldata for a sealed intent. */
export function enqueueData(sealed: Hex): Hex {
  if ((sealed.length - 2) / 2 !== INTENT_LEN) throw new Error(`an intent is ${INTENT_LEN} bytes`)
  return concatHex([SELECTORS.enqueue, numberToHex(32, { size: 32 }), numberToHex(INTENT_LEN, { size: 32 }), pad(sealed, { dir: 'right', size: 128 })])
}

export const randomSalt = (): Hex => bytesToHex(randomBytes(32))
