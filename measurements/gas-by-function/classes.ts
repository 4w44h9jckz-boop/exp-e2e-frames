// What a mainnet transaction's gas paid for, decided from the receipt alone: its status, its type,
// and the events it emitted. Each transaction goes in the first class that matches, in CLASSES
// order. Every event signature is hashed here from its text, and a run counts the transactions each
// one matched, so a signature written wrong shows as a zero rather than as a quiet misclassification.
import { toEventSelector } from 'viem'

export const EVENTS: Record<string, string[]> = {
  'rollup-settle': [
    'DisputeGameCreated(address,uint32,bytes32)', // OP Stack DisputeGameFactory
    'OutputProposed(bytes32,uint256,uint256,uint256)', // OP Stack L2OutputOracle
    'SequencerBatchDelivered(uint256,bytes32,bytes32,bytes32,uint256,(uint64,uint64,uint64,uint64),uint8)', // Arbitrum
    'AssertionConfirmed(bytes32,bytes32,bytes32)', // Arbitrum BoLD
    'BlockCommit(uint256,bytes32,bytes32)', // ZKsync
    'BlocksVerification(uint256,uint256)', // ZKsync
    'BlockExecution(uint256,bytes32,bytes32)', // ZKsync
    'LogStateUpdate(uint256,int256,uint256)', // Starknet
    'CommitBatch(uint256,bytes32)', // Scroll
    'FinalizeBatch(uint256,bytes32,bytes32,bytes32)', // Scroll
    'DataSubmittedV3(bytes32,bytes32,bytes32)', // Linea
    'DataFinalizedV3(uint256,uint256,bytes32,bytes32,bytes32)', // Linea
  ],
  bridge: [
    'TransactionDeposited(address,address,uint256,bytes)', // OP Stack portal
    'WithdrawalProven(bytes32,address,address)', // OP Stack portal
    'WithdrawalFinalized(bytes32,bool)', // OP Stack portal
    'MessageDelivered(uint256,bytes32,address,uint8,address,bytes32,uint256,uint64)', // Arbitrum bridge
    'OutBoxTransactionExecuted(address,address,uint256,uint256)', // Arbitrum outbox
    'NewPriorityRequest(uint256,bytes32,uint64,(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256[4],bytes,bytes,uint256[],bytes,bytes),bytes[])', // ZKsync
  ],
  trade: [
    'Swap(address,uint256,uint256,uint256,uint256,address)', // Uniswap V2 and forks
    'Swap(address,address,int256,int256,uint160,uint128,int24)', // Uniswap V3 and forks
    'Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)', // PancakeSwap V3
    'Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)', // Uniswap V4
    'Swap(bytes32,address,address,uint256,uint256)', // Balancer V2
    'TokenExchange(address,int128,uint256,int128,uint256)', // Curve stableswap
    'TokenExchangeUnderlying(address,int128,uint256,int128,uint256)', // Curve stableswap
    'TokenExchange(address,uint256,uint256,uint256,uint256)', // Curve cryptoswap
    'TokenExchange(address,uint256,uint256,uint256,uint256,uint256,uint256)', // Curve tricrypto-ng
    'Trade(address,address,address,uint256,uint256,uint256,bytes)', // CoW Protocol
    'Fill(bytes32,address,address,uint256)', // UniswapX
    'OrderFilled(bytes32,uint256)', // 1inch limit orders
  ],
  'lend-or-pool': [
    'Supply(address,address,address,uint256,uint16)', // Aave V3 and forks
    'Withdraw(address,address,address,uint256)', // Aave V3
    'Borrow(address,address,address,uint256,uint8,uint256,uint16)', // Aave V3
    'Repay(address,address,address,uint256,bool)', // Aave V3
    'LiquidationCall(address,address,address,uint256,uint256,address,bool)', // Aave V3
    'Supply(bytes32,address,address,uint256,uint256)', // Morpho Blue
    'Withdraw(bytes32,address,address,address,uint256,uint256)', // Morpho Blue
    'Borrow(bytes32,address,address,address,uint256,uint256)', // Morpho Blue
    'Repay(bytes32,address,address,uint256,uint256)', // Morpho Blue
    'SupplyCollateral(bytes32,address,address,uint256)', // Morpho Blue
    'WithdrawCollateral(bytes32,address,address,address,uint256)', // Morpho Blue
    'Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)', // Morpho Blue
    'Supply(address,address,uint256)', // Compound V3
    'Withdraw(address,address,uint256)', // Compound V3
    'SupplyCollateral(address,address,address,uint256)', // Compound V3
    'WithdrawCollateral(address,address,address,uint256)', // Compound V3
    'Deposit(address,address,uint256,uint256)', // ERC-4626
    'Withdraw(address,address,address,uint256,uint256)', // ERC-4626
  ],
  oracle: [
    'AnswerUpdated(int256,uint256,uint256)', // Chainlink aggregator
    'NewTransmission(uint32,int192,address,int192[],bytes,bytes32)', // Chainlink OCR1
    'NewTransmission(uint32,int192,address,uint32,int192[],bytes,bytes32)', // Chainlink OCR2
  ],
  'validator-deposit': [
    'DepositEvent(bytes,bytes,bytes,bytes,bytes)', // beacon deposit contract
  ],
  'token-move': [
    'Transfer(address,address,uint256)', // ERC-20 and ERC-721
    'Approval(address,address,uint256)', // ERC-20 and ERC-721
    'ApprovalForAll(address,address,bool)', // ERC-721 and ERC-1155
    'TransferSingle(address,address,address,uint256,uint256)', // ERC-1155
    'TransferBatch(address,address,address,uint256[],uint256[])', // ERC-1155
    'Deposit(address,uint256)', // WETH wrap
    'Withdrawal(address,uint256)', // WETH unwrap
  ],
}

/** The classes decided by events, in the order they are tried. */
export const ORDER = ['rollup-settle', 'bridge', 'trade', 'lend-or-pool', 'oracle', 'validator-deposit', 'token-move']
export const CLASSES = ['reverted', 'blob-carrier', ...ORDER, 'eth-transfer', 'create', 'other-call']

/** topic -> signature, per class. */
export const TOPICS: Record<string, Map<string, string>> = Object.fromEntries(
  Object.entries(EVENTS).map(([cls, sigs]) => [cls, new Map(sigs.map((s) => [toEventSelector(s).toLowerCase(), s]))]),
)

export type Tx = { type?: string; to: string | null; input: string }
export type Receipt = { status: string; logs: { topics: string[] }[] }

/** The transaction's class; counts each signature that decided it in `hits`. */
export function classify(tx: Tx, rc: Receipt, hits: Map<string, number>): string {
  if (Number.parseInt(rc.status, 16) === 0) return 'reverted'
  if (Number.parseInt(tx.type ?? '0x0', 16) === 3) return 'blob-carrier'
  const seen = new Set(rc.logs.filter((l) => l.topics.length > 0).map((l) => l.topics[0].toLowerCase()))
  for (const cls of ORDER) {
    const matched = [...seen].filter((t) => TOPICS[cls].has(t))
    if (matched.length > 0) {
      for (const t of matched) {
        const sig = TOPICS[cls].get(t)!
        hits.set(sig, (hits.get(sig) ?? 0) + 1)
      }
      return cls
    }
  }
  if (tx.to === null) return 'create'
  if (tx.input === '0x' || tx.input === '') return 'eth-transfer'
  return 'other-call'
}

export const PRECOMPILES: Record<number, string> = {
  0x01: 'ecrecover', 0x02: 'sha256', 0x03: 'ripemd160', 0x04: 'identity', 0x05: 'modexp',
  0x06: 'bn254-add', 0x07: 'bn254-mul', 0x08: 'bn254-pairing', 0x09: 'blake2f',
  0x0a: 'kzg-point-evaluation', 0x0b: 'bls12-g1add', 0x0c: 'bls12-g1msm', 0x0d: 'bls12-g2add',
  0x0e: 'bls12-g2msm', 0x0f: 'bls12-pairing', 0x10: 'bls12-map-fp-to-g1',
  0x11: 'bls12-map-fp2-to-g2', 0x100: 'p256verify',
}
/** Precompiles that are not signature or proof checks. Identity is a copy, and is left out of the verification total. */
export const KIND: Record<string, string> = {
  ecrecover: 'signature', p256verify: 'signature', sha256: 'hash', ripemd160: 'hash', blake2f: 'hash', identity: 'copy',
}

export type Frame = { to?: string | null; gasUsed?: string; calls?: Frame[] }

/** Adds the gas charged inside every precompile call in a call-tracer frame tree to `out`. */
export function precompileGas(frame: Frame, out: Map<string, number>): void {
  if (frame.to) {
    const a = BigInt(frame.to)
    if (a <= 0x100n && PRECOMPILES[Number(a)]) {
      const name = PRECOMPILES[Number(a)]
      out.set(name, (out.get(name) ?? 0) + Number.parseInt(frame.gasUsed ?? '0x0', 16))
    }
  }
  for (const c of frame.calls ?? []) precompileGas(c, out)
}
