import { type Hex, hexToBytes } from 'viem'
import {
  FRAME_TX_INTRINSIC_COST,
  FRAME_TX_PER_FRAME_COST,
  GAS_PER_BLOB,
  SIGNATURE_GAS,
  STANDARD_TOKEN_COST,
  TOTAL_COST_FLOOR_PER_TOKEN,
  TX_MAX_GAS_LIMIT,
  TX_VALUE_COST,
} from './constants.js'
import { nonceCalldata } from './encode.js'
import type { FrameTx } from './types.js'

// Mirrors the "Gas Accounting" section of EIP-8141 (+ EIP-8250 nonce calldata), checked
// against ethrex's FrameTransaction::{mandatory_gas,data_cost,max_gas,max_cost}.

/** Every byte string the data cost is charged over. */
function dataFields(tx: FrameTx): Hex[] {
  const out: Hex[] = tx.frames.map((f) => f.data)
  for (const s of tx.signatures) out.push(s.signer ?? '0x', s.msg, s.signature)
  out.push(nonceCalldata(tx))
  return out
}

/** 4 gas per zero byte, 16 per non-zero byte. */
export function calldataCost(data: Hex): bigint {
  let cost = 0n
  for (const b of hexToBytes(data)) cost += b === 0 ? STANDARD_TOKEN_COST : 4n * STANDARD_TOKEN_COST
  return cost
}

export function signatureVerificationGas(tx: FrameTx): bigint {
  return tx.signatures.reduce((acc, s) => {
    const g = SIGNATURE_GAS[s.scheme]
    if (g === undefined) throw new Error(`unknown signature scheme ${s.scheme}`)
    return acc + g
  }, 0n)
}

/** TX_VALUE_COST per frame moving value to an explicit target other than the sender. */
export function valueTransferGas(tx: FrameTx): bigint {
  const sender = tx.sender.toLowerCase()
  return tx.frames.reduce(
    (acc, f) => (f.value > 0n && f.target !== null && f.target.toLowerCase() !== sender ? acc + TX_VALUE_COST : acc),
    0n,
  )
}

/** Costs charged in full on both sides of the calldata-floor comparison. */
export function mandatoryGas(tx: FrameTx): bigint {
  return (
    FRAME_TX_INTRINSIC_COST +
    BigInt(tx.frames.length) * FRAME_TX_PER_FRAME_COST +
    signatureVerificationGas(tx) +
    valueTransferGas(tx)
  )
}

export function dataCost(tx: FrameTx): bigint {
  return dataFields(tx).reduce((acc, d) => acc + calldataCost(d), 0n)
}

/** `frame_tx_intrinsic_gas`: charged before any frame runs, outside frame budgets. */
export function intrinsicGas(tx: FrameTx): bigint {
  return mandatoryGas(tx) + dataCost(tx)
}

/** `calldata_floor_gas`: mandatory costs + 16 gas per token, 4 tokens per byte. */
export function calldataFloorGas(tx: FrameTx): bigint {
  const bytes = dataFields(tx).reduce((acc, d) => acc + BigInt(hexToBytes(d).length), 0n)
  return mandatoryGas(tx) + bytes * STANDARD_TOKEN_COST * TOTAL_COST_FLOOR_PER_TOKEN
}

export function totalExecutionLimit(tx: FrameTx): bigint {
  return tx.frames.reduce((acc, f) => acc + f.limits.execution, 0n)
}

export function totalStateLimit(tx: FrameTx): bigint {
  return tx.frames.reduce((acc, f) => acc + f.limits.state, 0n)
}

export function standardGasLimit(tx: FrameTx): bigint {
  return intrinsicGas(tx) + totalExecutionLimit(tx) + totalStateLimit(tx)
}

/** `max_gas`: what `max_cost` is charged over. */
export function maxGas(tx: FrameTx): bigint {
  const std = standardGasLimit(tx)
  const floor = calldataFloorGas(tx) + totalStateLimit(tx)
  return std > floor ? std : floor
}

/** `TXPARAM(0x06)`: the amount APPROVE(PAYMENT) escrows from the payer. */
export function maxCost(tx: FrameTx, blobBaseFee = 0n): bigint {
  return maxGas(tx) * tx.fees.maxFeePerGas + BigInt(tx.blobVersionedHashes.length) * GAS_PER_BLOB * blobBaseFee
}

/** EIP-7825 cap on intrinsic + execution budgets (state gas excluded). */
export function executionReservation(tx: FrameTx): bigint {
  const a = intrinsicGas(tx) + totalExecutionLimit(tx)
  const b = calldataFloorGas(tx)
  return a > b ? a : b
}

export function fitsTxGasCap(tx: FrameTx): boolean {
  return executionReservation(tx) <= TX_MAX_GAS_LIMIT
}

export type FrameGasUsed = { execution: bigint; state: bigint }

/**
 * Transaction `gas_used` from per-frame receipts, per "Transaction settlement".
 * `refund` is the EIP-3529 refund counter (not exposed by the RPC; 0 unless storage is cleared).
 */
export function settledGasUsed(tx: FrameTx, frames: FrameGasUsed[], refund = 0n): bigint {
  const exec = frames.reduce((a, f) => a + f.execution, 0n)
  const state = frames.reduce((a, f) => a + f.state, 0n)
  const beforeRefund = intrinsicGas(tx) + exec + state
  const applied = refund < beforeRefund / 5n ? refund : beforeRefund / 5n
  const execPart = beforeRefund - applied - state
  const floor = calldataFloorGas(tx)
  return (execPart > floor ? execPart : floor) + state
}

/** Breakdown handy for printing. */
export function gasSummary(tx: FrameTx) {
  return {
    intrinsic: intrinsicGas(tx),
    mandatory: mandatoryGas(tx),
    dataCost: dataCost(tx),
    calldataFloor: calldataFloorGas(tx),
    executionLimits: totalExecutionLimit(tx),
    stateLimits: totalStateLimit(tx),
    maxGas: maxGas(tx),
    maxCost: maxCost(tx),
  }
}
