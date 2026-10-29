import type { Address, Hex } from 'viem'

export type FrameLimits = {
  /** Execution-gas budget (`limits.execution`). */
  execution: bigint
  /** EIP-8037 state-gas budget (`limits.state`). */
  state: bigint
}

export type Frame = {
  mode: number
  flags: number
  /** `null` resolves to `tx.sender`. */
  target: Address | null
  limits: FrameLimits
  value: bigint
  data: Hex
}

export type FrameSignature = {
  scheme: number
  /** `null` resolves to `tx.sender` for SECP256K1/P256; must be `null` for ARBITRARY. */
  signer: Address | null
  /** `0x` = sign the canonical sig hash; otherwise an explicit 32-byte digest. */
  msg: Hex
  /** SECP256K1: yParity(1) || r(32) || s(32). P256: r || s || qx || qy. */
  signature: Hex
}

export type FrameTxFees = {
  maxPriorityFeePerGas: bigint
  maxFeePerGas: bigint
  maxFeePerBlobGas: bigint
}

/**
 * Which nonce the envelope carries.
 * - `keyed`: EIP-8250, as the ethrex Hegota testnet and frames-devnet-1 encode it:
 *   `[chain_id, nonce_keys, nonce_seq, sender, frames, signatures, fees, blob_versioned_hashes]`.
 * - `plain`: EIP-8141 alone, as frames-devnet-0 encodes it:
 *   `[chain_id, nonce, sender, frames, signatures, fees, blob_versioned_hashes]`.
 */
export type FrameTxEnvelope = 'keyed' | 'plain'

/** A type-0x06 transaction. */
export type FrameTx = {
  chainId: bigint
  /** Absent means `keyed`. A `plain` envelope requires `nonceKeys` = `[0n]`. */
  envelope?: FrameTxEnvelope
  /** EIP-8250. `[0n]` is the legacy account nonce. */
  nonceKeys: bigint[]
  /** EIP-8250's sequence; in a `plain` envelope, the account nonce. */
  nonceSeq: bigint
  sender: Address
  frames: Frame[]
  signatures: FrameSignature[]
  fees: FrameTxFees
  blobVersionedHashes: Hex[]
}
