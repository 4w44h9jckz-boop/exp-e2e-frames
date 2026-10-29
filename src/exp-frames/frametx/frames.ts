import type { Address, Hex } from 'viem'
import { ATOMIC_BATCH_FLAG, Approve, EXPIRY_VERIFIER, Mode } from './constants.js'
import type { Frame } from './types.js'

// Small constructors so experiment scripts read like the EIP's example tables.

type Limits = { execution: bigint; state?: bigint }

/** VERIFY frame. `target: null` resolves to the sender (default code for an EOA). */
export function verifyFrame(opts: {
  scope: number
  target?: Address | null
  data?: Hex
} & Limits): Frame {
  return {
    mode: Mode.VERIFY,
    flags: opts.scope,
    target: opts.target ?? null,
    limits: { execution: opts.execution, state: opts.state ?? 0n },
    value: 0n,
    data: opts.data ?? '0x',
  }
}

/** SENDER frame: runs with `caller = tx.sender`. `atomic` chains it with the next frame. */
export function senderFrame(opts: {
  target: Address | null
  value?: bigint
  data?: Hex
  atomic?: boolean
} & Limits): Frame {
  return {
    mode: Mode.SENDER,
    flags: opts.atomic ? ATOMIC_BATCH_FLAG : 0,
    target: opts.target,
    limits: { execution: opts.execution, state: opts.state ?? 0n },
    value: opts.value ?? 0n,
    data: opts.data ?? '0x',
  }
}

/** DEFAULT frame: runs with `caller = ENTRY_POINT`. */
export function defaultFrame(opts: {
  target: Address | null
  data?: Hex
  atomic?: boolean
} & Limits): Frame {
  return {
    mode: Mode.DEFAULT,
    flags: opts.atomic ? ATOMIC_BATCH_FLAG : 0,
    target: opts.target,
    limits: { execution: opts.execution, state: opts.state ?? 0n },
    value: 0n,
    data: opts.data ?? '0x',
  }
}

/** Expiry verifier frame: reverts (invalidating the tx) once block.timestamp > deadline. */
export function expiryFrame(deadline: bigint, execution = 5_000n): Frame {
  return {
    mode: Mode.VERIFY,
    flags: Approve.NONE,
    target: EXPIRY_VERIFIER,
    limits: { execution, state: 0n },
    value: 0n,
    data: `0x${deadline.toString(16).padStart(16, '0')}`,
  }
}
