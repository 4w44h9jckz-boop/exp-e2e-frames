// Experiment 24 (X17): the two pools and the self-paying withdrawal's frame transaction.
//
// Arm A's pool is experiment 19's version 4 (Pool4.yul) and arm B's is PoolSelf.yul. Both take the
// same verifier, experiment 19's verifier4 for tornado.sh's circuit, and the same hasher,
// experiment 06's MiMC. Each is deployed fresh under this experiment's own salt, so its tree holds
// only this run's notes.
import { type Address, type Hex, concatHex, encodeFunctionData, keccak256, pad, parseAbi, toHex } from 'viem'
import { compileYul } from '../../src/exp-frames/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/exp-frames/deploy.js'
import { Approve, type FrameTx, NEW_ACCOUNT_STATE_GAS, STORAGE_SET_STATE_GAS, defaultFrame, senderFrame, verifyFrame } from '../../src/exp-frames/frametx/index.js'
import { HASHER } from '../15-x10-out-and-back/x10.js'
import * as X14 from '../19-x14-hash-based-stealth-addresses-under-8288/x14.js'

export const DIR = 'experiments/24-x17-a-private-withdrawal-with-and-without-a-relayer'
export const DEPLOYMENT = process.env.X17_DEPLOYMENT ?? 'd1'
const tag = (l: string) => `exp-e2e-frames/24/${DEPLOYMENT}/${l}`
export const keyOf = (base: Hex, l: string): Hex => keccak256(concatHex([base, toHex(tag(`key/${l}`))]))
export const DENOM = X14.DENOM
export const word = X14.word

const fixed = (initcode: Hex, l: string, extraState = 0n) => {
  const code = initcode.toLowerCase() as Hex
  const salt = saltOf(tag(l))
  return { label: l, initcode: code, salt, address: create2Address(code, salt), deploy: deployFrame(code, salt, extraState).frame }
}

/** The verifier for tornado.sh's circuit: experiment 19's, deployed fresh here under this salt. */
export const verifier = fixed(X14.verifier4.initcode, 'verifier')
export const poolA = fixed(concatHex([compileYul('experiments/19-x14-hash-based-stealth-addresses-under-8288/contracts/Pool4.yul'), pad(verifier.address), pad(HASHER)]), 'pool-a')
export const poolB = fixed(concatHex([compileYul(`${DIR}/contracts/PoolSelf.yul`), pad(verifier.address), pad(HASHER)]), 'pool-b')

export const poolAbi = parseAbi([
  'function deposit(bytes32 commitment) payable',
  'function withdraw(uint256[8] proof, bytes32 root, bytes32 nullifierHash, address recipient, address relayer, uint256 fee, uint256 refund)',
  'event Deposit(bytes32 commitment, uint256 leafIndex)',
  'event Withdrawal(address to, bytes32 nullifierHash, address relayer, uint256 fee)',
])

/** The fees both arms' transactions offer: experiment 19's, 1 wei of tip and 100 wei at most. */
export const FEES = X14.FEES

/** Limits, set once before the run: the proof's check fits the test network's 500,000. */
export const VERIFY_EXECUTION = 320_000n
export const WITHDRAW_EXECUTION = 100_000n
export const REFUND_EXECUTION = 25_000n

/**
 * Arm B: the pool as sender and payer of its own withdrawal, frames [VERIFY, SENDER withdraw,
 * DEFAULT refund], the nullifier hash as the one nonce key, relayer = the pool, refund field 0.
 */
export function withdrawSelfTx(chainId: bigint, proof: readonly bigint[], root: Hex, nullifierHash: Hex, recipient: Address, fee: bigint): FrameTx {
  const data = encodeFunctionData({ abi: poolAbi, functionName: 'withdraw', args: [proof as never, root, nullifierHash, recipient, poolB.address, fee, 0n] })
  return {
    chainId, nonceKeys: [BigInt(nullifierHash)], nonceSeq: 0n, sender: poolB.address,
    frames: [
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, execution: VERIFY_EXECUTION, state: STORAGE_SET_STATE_GAS }),
      senderFrame({ target: poolB.address, data, execution: WITHDRAW_EXECUTION, state: NEW_ACCOUNT_STATE_GAS }),
      defaultFrame({ target: poolB.address, execution: REFUND_EXECUTION }),
    ],
    signatures: [], fees: FEES, blobVersionedHashes: [],
  }
}

/** Every address a transaction names: its sender or `from`, its targets, and the calldata's address fields. */
export function namesIn(fields: { from: Address; targets: (Address | null)[]; recipient: Address; relayer: Address }): Address[] {
  const all = [fields.from, ...fields.targets.filter((t): t is Address => t !== null), fields.recipient, fields.relayer]
  return [...new Set(all.map((a) => a.toLowerCase() as Address))]
}
