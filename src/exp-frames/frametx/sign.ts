import { p256 } from '@noble/curves/p256'
import {
  type Address,
  type Hex,
  bytesToHex,
  concatHex,
  getAddress,
  hexToBytes,
  isAddressEqual,
  keccak256,
  numberToHex,
  pad,
  slice,
  toHex,
} from 'viem'
import { privateKeyToAddress, sign } from 'viem/accounts'
import { Scheme } from './constants.js'
import { frameSigHash } from './encode.js'
import type { FrameSignature, FrameTx } from './types.js'

/** yParity(1) || r(32) || s(32). v is the bare recovery id 0/1, not 27/28. */
export async function secp256k1Sign(digest: Hex, privateKey: Hex): Promise<Hex> {
  const sig = await sign({ hash: digest, privateKey })
  if (sig.yParity === undefined) throw new Error('signer returned no yParity')
  return concatHex([toHex(sig.yParity, { size: 1 }), pad(sig.r, { size: 32 }), pad(sig.s, { size: 32 })])
}

/** A SECP256K1 entry with an empty signature, to be filled by `signFrameTx`. */
export function secp256k1Placeholder(signer: FrameSignature['signer'] = null, msg: Hex = '0x'): FrameSignature {
  return { scheme: Scheme.SECP256K1, signer, msg, signature: '0x' }
}

/** Fill this key's SECP256K1 entries (empty-msg ones sign the sig hash). See `signAll` for several keys. */
export async function signFrameTx(tx: FrameTx, privateKey: Hex): Promise<FrameTx> {
  return signAll(tx, [privateKey])
}

// ---- P256 (secp256r1, scheme 0x2) ----

/** A P256 private key, kept apart from secp256k1 keys so the two cannot be mixed up. */
export type P256Key = { scheme: 'p256'; privateKey: Hex }

export function generateP256Key(): P256Key {
  return { scheme: 'p256', privateKey: bytesToHex(p256.utils.randomPrivateKey()) }
}

/** The uncompressed public key coordinates. */
export function p256PublicKey(key: P256Key): { qx: Hex; qy: Hex } {
  const pub = p256.getPublicKey(hexToBytes(key.privateKey), false) // 0x04 ‖ qx ‖ qy
  return { qx: bytesToHex(pub.subarray(1, 33)), qy: bytesToHex(pub.subarray(33)) }
}

/** The P256 signer address: keccak256(qx ‖ qy)[12:]. */
export function p256Address(key: P256Key): Address {
  const { qx, qy } = p256PublicKey(key)
  return getAddress(slice(keccak256(concatHex([qx, qy])), 12))
}

/** r ‖ s ‖ qx ‖ qy, signing the 32-byte digest as is (no prehash) with low s, as the protocol requires. */
export function p256Sign(digest: Hex, key: P256Key): Hex {
  const sig = p256.sign(hexToBytes(digest), hexToBytes(key.privateKey), { lowS: true, prehash: false })
  const { qx, qy } = p256PublicKey(key)
  return concatHex([numberToHex(sig.r, { size: 32 }), numberToHex(sig.s, { size: 32 }), qx, qy])
}

/** A P256 entry with an empty signature, to be filled by `signFrameTx`. */
export function p256Placeholder(signer: FrameSignature['signer'], msg: Hex = '0x'): FrameSignature {
  return { scheme: Scheme.P256, signer, msg, signature: '0x' }
}

/** Fill this key's P256 entries (empty-msg ones sign the sig hash). See `signAll` for several keys. */
export async function signFrameTxP256(tx: FrameTx, key: P256Key): Promise<FrameTx> {
  return signAll(tx, [key])
}

/** A secp256k1 private key (hex) or a P256 key. */
export type AnyKey = Hex | P256Key

/** Sign with either kind of key. */
export async function signWith(tx: FrameTx, key: AnyKey): Promise<FrameTx> {
  return signAll(tx, [key])
}

const schemeOf = (key: AnyKey) => (typeof key === 'string' ? Scheme.SECP256K1 : Scheme.P256)
const addressOfKey = (key: AnyKey): Address => (typeof key === 'string' ? privateKeyToAddress(key) : p256Address(key))

/** Fill the entries of one kind (explicit digest, or sig hash) that resolve to this key. */
async function fill(tx: FrameTx, key: AnyKey, sigHashEntries: boolean): Promise<{ tx: FrameTx; filled: number }> {
  const me = addressOfKey(key)
  const sigHash = frameSigHash(tx)
  let filled = 0
  const signatures = await Promise.all(
    tx.signatures.map(async (s) => {
      if (s.scheme !== schemeOf(key) || !isAddressEqual(s.signer ?? tx.sender, me)) return s
      if ((s.msg === '0x') !== sigHashEntries) return s
      filled++
      const digest = sigHashEntries ? sigHash : s.msg
      return { ...s, signature: typeof key === 'string' ? await secp256k1Sign(digest, key) : p256Sign(digest, key) }
    }),
  )
  return { tx: { ...tx, signatures }, filled }
}

/**
 * Fill every SECP256K1 / P256 entry that resolves to one of `keys`. The sig hash elides only
 * empty-`msg` signatures, so an explicit-digest signature is part of what the others sign:
 * every key fills its explicit-digest entries first, then every key signs the sig hash.
 * Entries for other signers are left alone.
 */
export async function signAll(tx: FrameTx, keys: AnyKey[]): Promise<FrameTx> {
  const filled = keys.map(() => 0)
  for (const sigHashEntries of [false, true]) {
    for (const [i, key] of keys.entries()) {
      const r = await fill(tx, key, sigHashEntries)
      tx = r.tx
      filled[i] += r.filled
    }
  }
  const idle = filled.indexOf(0)
  if (idle >= 0) {
    const key = keys[idle]
    throw new Error(`no ${schemeOf(key) === Scheme.P256 ? 'P256' : 'SECP256K1'} signature entry resolves to ${addressOfKey(key)}`)
  }
  return tx
}
