import type { Address } from 'viem'

// EIP-8141 as pinned by the ethrex Hegotá testnet (ethereum/EIPs@b75cbe6115),
// combined with EIP-8250 keyed nonces (ethereum/EIPs@f3079a09e8).

export const FRAME_TX_TYPE = 0x06

/** Frame `mode` values. */
export const Mode = {
  /** Execute as ENTRY_POINT (0xaa). */
  DEFAULT: 0,
  /** Static call; authorisation happens here via APPROVE. A revert invalidates the tx. */
  VERIFY: 1,
  /** Execute as `tx.sender`; requires `sender_approved`. */
  SENDER: 2,
} as const

/** APPROVE scope bits, also the low two bits of `frame.flags`. */
export const Approve = {
  NONE: 0x0,
  PAYMENT: 0x1,
  EXECUTION: 0x2,
  EXECUTION_AND_PAYMENT: 0x3,
} as const

export const APPROVE_SCOPE_MASK = 0x3
export const ATOMIC_BATCH_FLAG = 0x4

/** Signature `scheme` values. */
export const Scheme = {
  ARBITRARY: 0x0,
  SECP256K1: 0x1,
  P256: 0x2,
} as const

/** Per-frame receipt status. */
export const FrameStatus = {
  FAILURE: 0,
  SUCCESS: 1,
  SKIPPED: 2,
} as const

/** New opcodes. */
export const Opcode = {
  APPROVE: 0xaa,
  TXPARAM: 0xb0,
  FRAMEDATALOAD: 0xb1,
  FRAMEDATACOPY: 0xb2,
  FRAMEPARAM: 0xb3,
  SIGPARAM: 0xb4,
  SIGDATACOPY: 0xb5,
} as const

// ---- gas ----
export const FRAME_TX_INTRINSIC_COST = 12_000n
export const FRAME_TX_PER_FRAME_COST = 475n
export const TX_VALUE_COST = 6_000n
export const SIGNATURE_GAS: Record<number, bigint> = {
  [Scheme.ARBITRARY]: 100n,
  [Scheme.SECP256K1]: 2_800n,
  [Scheme.P256]: 6_700n,
}
export const STANDARD_TOKEN_COST = 4n
export const TOTAL_COST_FLOOR_PER_TOKEN = 16n
export const TX_MAX_GAS_LIMIT = 16_777_216n
export const GAS_PER_BLOB = 131_072n

/** EIP-8037 cost per state byte. */
export const CPSB = 1_530n
/** State gas to create an account (e.g. a value transfer to a fresh address). */
export const NEW_ACCOUNT_STATE_GAS = 120n * CPSB // 183,600
/** State gas to set a fresh storage slot (also the first use of a keyed nonce). */
export const STORAGE_SET_STATE_GAS = 64n * CPSB // 97,920

export const MAX_FRAMES = 64
export const MAX_NONCE_KEYS = 16

/** Public-mempool caps. The testnet nodes run with --mempool.max-verify-gas=500000. */
export const MAX_VERIFY_GAS_SPEC = 100_000n
export const MAX_VERIFY_GAS_TESTNET = 500_000n
export const MAX_VERIFY_STATE_GAS = 500_000n

// ---- addresses ----
export const ENTRY_POINT: Address = '0x00000000000000000000000000000000000000aa'
/**
 * Expiry verifier. The pinned EIP (and the testnet) install it at 0x8141;
 * EIP master later moved it to a keyless deployment at 0x81413f0c…FfFf.
 */
export const EXPIRY_VERIFIER: Address = '0x0000000000000000000000000000000000008141'
/** EIP-8250 keyed-nonce storage. */
export const NONCE_MANAGER: Address = '0x0000000000000000000000000000000000008250'
/** EIP-8272 recent-roots predeploy. */
export const RECENT_ROOT: Address = '0x0000000000000000000000000000000000008272'
/** Arachnid's deterministic CREATE2 deployer: calldata = salt(32) || initcode. Present on the testnet. */
export const CREATE2_DEPLOYER: Address = '0x4e59b44847b379578588920ca78fbf26c0b4956c'
/** EIP-7708 transfer-log emitter. */
export const SYSTEM_LOG_ADDRESS: Address = '0xfffffffffffffffffffffffffffffffffffffffe'
