import {
  type Address,
  type Hex,
  concatHex,
  fromRlp,
  getAddress,
  hexToBigInt,
  keccak256,
  toRlp,
} from 'viem'
import { FRAME_TX_TYPE, MAX_FRAMES, MAX_NONCE_KEYS } from './constants.js'
import type { Frame, FrameSignature, FrameTx } from './types.js'

type Rlp = Hex | readonly Rlp[]

const TYPE_PREFIX: Hex = `0x0${FRAME_TX_TYPE}`

/** Canonical minimal big-endian integer, `0x` for zero. */
export function rlpInt(n: bigint | number): Hex {
  const v = BigInt(n)
  if (v < 0n) throw new Error(`negative integer: ${v}`)
  if (v === 0n) return '0x'
  const h = v.toString(16)
  return `0x${h.length % 2 ? '0' : ''}${h}`
}

/** Address, or empty bytes for `null`. */
function rlpAddr(a: Address | null): Hex {
  return a === null ? '0x' : (a.toLowerCase() as Hex)
}

function frameFields(f: Frame): Rlp {
  return [
    rlpInt(f.mode),
    rlpInt(f.flags),
    rlpAddr(f.target),
    [rlpInt(f.limits.execution), rlpInt(f.limits.state)],
    rlpInt(f.value),
    f.data,
  ]
}

function signatureFields(s: FrameSignature, elide: boolean): Rlp {
  const sig = elide && s.msg === '0x' ? '0x' : s.signature
  return [rlpInt(s.scheme), rlpAddr(s.signer), s.msg, sig]
}

/** Whether `tx` uses EIP-8141's own single nonce rather than EIP-8250's keyed one. */
export function isPlain(tx: FrameTx): boolean {
  if (tx.envelope !== 'plain') return false
  if (tx.nonceKeys.length !== 1 || tx.nonceKeys[0] !== 0n) throw new Error('a plain envelope has no nonce keys; set nonceKeys to [0n]')
  return true
}

function nonceFields(tx: FrameTx): Rlp[] {
  return isPlain(tx) ? [rlpInt(tx.nonceSeq)] : [tx.nonceKeys.map(rlpInt), rlpInt(tx.nonceSeq)]
}

function envelope(tx: FrameTx, elide: boolean): Rlp {
  return [
    rlpInt(tx.chainId),
    ...nonceFields(tx),
    rlpAddr(tx.sender),
    tx.frames.map(frameFields),
    tx.signatures.map((s) => signatureFields(s, elide)),
    [rlpInt(tx.fees.maxPriorityFeePerGas), rlpInt(tx.fees.maxFeePerGas), rlpInt(tx.fees.maxFeePerBlobGas)],
    tx.blobVersionedHashes,
  ]
}

/** RLP payload without the type byte. */
export function encodePayload(tx: FrameTx): Hex {
  return toRlp(envelope(tx, false))
}

/** `0x06 || rlp(payload)` — what eth_sendRawTransaction takes. */
export function serializeFrameTx(tx: FrameTx): Hex {
  return concatHex([TYPE_PREFIX, encodePayload(tx)])
}

/** Transaction hash: keccak256 of the full serialized envelope. */
export function frameTxHash(tx: FrameTx): Hex {
  return keccak256(serializeFrameTx(tx))
}

/**
 * Canonical signature hash (`compute_sig_hash`, `TXPARAM(0x08)`): the envelope with the
 * raw bytes of every empty-`msg` signature elided. Frame data is committed verbatim.
 */
export function frameSigHash(tx: FrameTx): Hex {
  return keccak256(concatHex([TYPE_PREFIX, toRlp(envelope(tx, true))]))
}

/**
 * `rlp(nonce_keys) || rlp(nonce_seq)` — EIP-8250 nonce bytes priced as calldata. A plain
 * envelope's nonce is not priced, as for any other transaction type.
 */
export function nonceCalldata(tx: FrameTx): Hex {
  if (isPlain(tx)) return '0x'
  return concatHex([toRlp(tx.nonceKeys.map(rlpInt)), toRlp(rlpInt(tx.nonceSeq))])
}

// ---- decoding ----

function asBytes(x: Rlp, what: string): Hex {
  if (typeof x !== 'string') throw new Error(`${what}: expected bytes, got list`)
  return x
}

function asList(x: Rlp, what: string): readonly Rlp[] {
  if (typeof x === 'string') throw new Error(`${what}: expected list, got bytes`)
  return x
}

function asInt(x: Rlp, what: string): bigint {
  const b = asBytes(x, what)
  if (b === '0x') return 0n
  if (b.startsWith('0x00')) throw new Error(`${what}: non-canonical integer ${b}`)
  return hexToBigInt(b)
}

function asOptAddr(x: Rlp, what: string): Address | null {
  const b = asBytes(x, what)
  if (b === '0x') return null
  if (b.length !== 42) throw new Error(`${what}: expected 20 bytes, got ${(b.length - 2) / 2}`)
  return getAddress(b)
}

const U64_LIMIT = 1n << 64n

/**
 * Parse a raw `0x06…` transaction, keyed (8 fields) or plain (7). Besides the structure, it refuses
 * what EIP-8141 and EIP-8250 say a decoder must: an RLP encoding that is not canonical (viem's
 * `fromRlp` accepts a byte under 0x80 with a length prefix, and a long-form length for a short
 * item); no nonce keys or more than 16, keys not strictly increasing, or key 0 beside another; a
 * nonce sequence of 2^64 or more; no frames or more than 64; limits of other than two fields.
 * These were found accepted by exp-e2e-frames' interop entry I2.
 */
export function parseFrameTx(raw: Hex): FrameTx {
  if (!raw.toLowerCase().startsWith(TYPE_PREFIX)) throw new Error(`not a type-0x06 transaction`)
  const body: Hex = `0x${raw.slice(4)}`
  const decoded = fromRlp(body, 'hex')
  if (toRlp(decoded).toLowerCase() !== body.toLowerCase()) throw new Error('envelope: not canonical RLP')
  const tx = parseFields(decoded)
  const keys = tx.nonceKeys
  if (keys.length === 0 || keys.length > MAX_NONCE_KEYS) throw new Error(`nonce_keys: ${keys.length} keys, not 1 to ${MAX_NONCE_KEYS}`)
  if (keys.some((k, i) => i > 0 && k <= keys[i - 1])) throw new Error('nonce_keys: not strictly increasing')
  if (keys.length > 1 && keys[0] === 0n) throw new Error('nonce_keys: key 0 is valid only alone')
  if (tx.nonceSeq >= U64_LIMIT) throw new Error(`nonce_seq: ${tx.nonceSeq} is not a uint64`)
  if (tx.frames.length === 0 || tx.frames.length > MAX_FRAMES) throw new Error(`frames: ${tx.frames.length} frames, not 1 to ${MAX_FRAMES}`)
  return tx
}

function parseFields(decoded: Rlp): FrameTx {
  const fields = asList(decoded, 'envelope')
  if (fields.length !== 8 && fields.length !== 7) throw new Error(`envelope: expected 7 or 8 fields, got ${fields.length}`)
  const plain = fields.length === 7
  const [chainId, nonceKeys, nonceSeq, sender, frames, signatures, fees, blobs] = plain
    ? [fields[0], ['0x'] as Rlp, ...fields.slice(1)]
    : fields
  const feeList = asList(fees, 'fees')
  const senderAddr = asOptAddr(sender, 'sender')
  if (senderAddr === null) throw new Error('sender: empty')
  return {
    chainId: asInt(chainId, 'chain_id'),
    ...(plain ? { envelope: 'plain' as const } : {}),
    nonceKeys: asList(nonceKeys, 'nonce_keys').map((k) => asInt(k, 'nonce_key')),
    nonceSeq: asInt(nonceSeq, 'nonce_seq'),
    sender: senderAddr,
    frames: asList(frames, 'frames').map((f, i) => {
      const [mode, flags, target, limits, value, data] = asList(f, `frames[${i}]`)
      const limitList = asList(limits, `frames[${i}].limits`)
      if (limitList.length !== 2) throw new Error(`frames[${i}].limits: ${limitList.length} fields, not 2`)
      const [execution, state] = limitList
      return {
        mode: Number(asInt(mode, 'mode')),
        flags: Number(asInt(flags, 'flags')),
        target: asOptAddr(target, `frames[${i}].target`),
        limits: { execution: asInt(execution, 'limits.execution'), state: asInt(state, 'limits.state') },
        value: asInt(value, 'value'),
        data: asBytes(data, 'data'),
      }
    }),
    signatures: asList(signatures, 'signatures').map((s, i) => {
      const [scheme, signer, msg, signature] = asList(s, `signatures[${i}]`)
      return {
        scheme: Number(asInt(scheme, 'scheme')),
        signer: asOptAddr(signer, `signatures[${i}].signer`),
        msg: asBytes(msg, 'msg'),
        signature: asBytes(signature, 'signature'),
      }
    }),
    fees: {
      maxPriorityFeePerGas: asInt(feeList[0], 'max_priority_fee_per_gas'),
      maxFeePerGas: asInt(feeList[1], 'max_fee_per_gas'),
      maxFeePerBlobGas: asInt(feeList[2], 'max_fee_per_blob_gas'),
    },
    blobVersionedHashes: asList(blobs, 'blob_versioned_hashes').map((h) => asBytes(h, 'blob hash')),
  }
}
