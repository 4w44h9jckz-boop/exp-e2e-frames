// Experiment 19 (X14): the contracts, the keys and the transactions of run 1. Addresses come from
// CREATE2 with label salts, and every key and secret from PRIVATE_KEY and a label, so every script
// sees the same parties. Nothing secret is printed or recorded.
import { readFileSync } from 'node:fs'
import { type Address, type Hex, bytesToHex, concatHex, encodeAbiParameters, encodeFunctionData, getContractAddress, keccak256, numberToHex, pad, parseAbi, toHex } from 'viem'
import { compileYul } from '../../src/exp-frames/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/exp-frames/deploy.js'
import { Approve, type FrameTx, type FrameTxFees, STORAGE_SET_STATE_GAS, senderFrame, verifyFrame } from '../../src/exp-frames/frametx/index.js'
import { HASHER } from '../15-x10-out-and-back/x10.js'

export const DIR = 'experiments/19-x14-hash-based-stealth-addresses-under-8288'
const here = (f: string) => new URL(f, import.meta.url).pathname
export const word = (x: bigint | number) => numberToHex(BigInt(x), { size: 32 })
export const DEPLOYMENT = process.env.X14_DEPLOYMENT ?? 'd1'
const tag = (l: string) => `exp-e2e-frames/19/${DEPLOYMENT}/${l}`
export const FEES: FrameTxFees = { maxPriorityFeePerGas: 1n, maxFeePerGas: 100n, maxFeePerBlobGas: 0n }
export const DENOM = 10n ** 15n

export const keyOf = (base: Hex, l: string): Hex => keccak256(concatHex([base, toHex(tag(`key/${l}`))]))
export const bytesOf = (base: Hex, l: string, n: number): Uint8Array => {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i += 32) out.set(Buffer.from(keyOf(base, `bytes/${l}/${i / 32}`).slice(2), 'hex').subarray(0, Math.min(32, n - i)), i)
  return out
}

// ---- EIP-8288, modelled ----

export const LEANSPHINCS_SCHEME = 0x10n
export const LEANSTARK_SCHEME = 0x11n
export const LEANSPHINCS_VERIFICATION_GAS = 3_000
export const LEANSTARK_VERIFICATION_GAS = 30_000
/**
 * A program's verification-key hash, as this run models it: keccak256 of the program's source at
 * leanVM 3cbac04. leanVM's own key is the program's compiled bytecode, which the prover does not
 * export; the source fixes it for a pinned compiler.
 */
export const vkOf = (program: string) => keccak256(readFileSync(here(`programs/${program}.py`)))
export const VK1 = vkOf('v1_preimage')
export const VK5 = vkOf('v5_tornado')
export const triple = (scheme: bigint, dataHash: Hex, vk: Hex) => concatHex([word(scheme), dataHash, vk])

// ---- contracts ----

const fixed = (initcode: Hex, l: string, extraState = 0n) => {
  const code = initcode.toLowerCase() as Hex
  const salt = saltOf(tag(l))
  return { label: l, initcode: code, salt, address: create2Address(code, salt), deploy: deployFrame(code, salt, extraState).frame }
}
export const stealthCode = compileYul(`${DIR}/contracts/Stealth.yul`)
const factoryCode = compileYul(`${DIR}/contracts/Factory.yul`)
// The factory's code carries Stealth's initcode, then its length.
export const factory = fixed(concatHex([factoryCode, stealthCode, word((stealthCode.length - 2) / 2)]), 'factory')
export const pool5 = fixed(concatHex([compileYul(`${DIR}/contracts/Pool5.yul`), VK5]), 'pool5')
type Vkey = { nPublic: number; vk_alpha_1: string[]; vk_beta_2: string[][]; vk_gamma_2: string[][]; vk_delta_2: string[][]; IC: string[][] }
export const VKEY4 = JSON.parse(readFileSync(here('build/withdraw.vkey.json'), 'utf8')) as Vkey
const g1 = (p: string[]) => [word(BigInt(p[0])), word(BigInt(p[1]))]
const g2 = (p: string[][]) => [word(BigInt(p[0][1])), word(BigInt(p[0][0])), word(BigInt(p[1][1])), word(BigInt(p[1][0]))]
const verifierCode = compileYul('experiments/15-x10-out-and-back/contracts/Groth16Verifier.yul')
export const verifier4 = fixed(concatHex([verifierCode, ...g1(VKEY4.vk_alpha_1), ...g2(VKEY4.vk_beta_2), ...g2(VKEY4.vk_gamma_2), ...g2(VKEY4.vk_delta_2), ...VKEY4.IC.flatMap(g1), word(VKEY4.nPublic)]), 'verifier4')
export const pool4 = fixed(concatHex([compileYul(`${DIR}/contracts/Pool4.yul`), pad(verifier4.address), pad(HASHER)]), 'pool4')

export const factoryAbi = parseAbi(['function pay(uint256 version, bytes32 word, bytes32 vk, bytes32 salt) payable', 'event Paid(address account)'])
export const stealthAbi = parseAbi(['function spend(address destination, uint256 amount)', 'function version() view returns (uint256)'])
export const pool5Abi = parseAbi(['function deposit(bytes32 commitment) payable', 'function withdraw(bytes32 root, bytes32 nf, address recipient, address relayer, uint256 fee)', 'event Deposit(bytes32 commitment, uint256 leafIndex)'])
export const pool4Abi = parseAbi(['function deposit(bytes32 commitment) payable', 'function withdraw(uint256[8] proof, bytes32 root, bytes32 nullifierHash, address recipient, address relayer, uint256 fee, uint256 refund)', 'event Deposit(bytes32 commitment, uint256 leafIndex)'])

/** The account a payment deploys: CREATE2 from the factory, the salt, and Stealth's initcode with its words. */
export const accountOf = (version: bigint, w: Hex, vk: Hex, salt: Hex): Address =>
  getContractAddress({ from: factory.address, opcode: 'CREATE2', salt, bytecode: concatHex([stealthCode, word(version), w, vk]) })

/** m = keccak256(DOMAIN || account || nonce || destination || amount), as Stealth.yul rebuilds it. */
export const SPEND_DOMAIN = keccak256(toHex('exp-e2e-frames/19/spend'))
export const messageOf = (account: Address, nonce: bigint, destination: Address, amount: bigint): Hex =>
  keccak256(concatHex([SPEND_DOMAIN, pad(account), word(nonce), pad(destination), word(amount)]))

/** A payment to a fresh address creates an account: its state gas on the test network (EIP-8037). */
export const NEW_ACCOUNT_STATE = 183_600n

/** The account as sender and payer of its spend: VERIFY carrying the dependency, then spend(). */
export function spendTx(chainId: bigint, account: Address, nonce: bigint, verifyData: Hex, destination: Address, amount: bigint): FrameTx {
  return {
    chainId, nonceKeys: [0n], nonceSeq: nonce, sender: account,
    frames: [
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, data: verifyData, execution: 60_000n, state: 0n }),
      senderFrame({ target: account, data: encodeFunctionData({ abi: stealthAbi, functionName: 'spend', args: [destination, amount] }), execution: 60_000n, state: NEW_ACCOUNT_STATE }),
    ],
    signatures: [], fees: FEES, blobVersionedHashes: [],
  }
}

/** The pool as sender and payer of a withdrawal: the nullifier hash its one nonce key. */
export function withdraw5Tx(chainId: bigint, nf: Hex, verifyData: Hex, root: Hex, recipient: Address, relayer: Address, fee: bigint): FrameTx {
  return {
    chainId, nonceKeys: [BigInt(nf)], nonceSeq: 0n, sender: pool5.address,
    frames: [
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, data: verifyData, execution: 60_000n, state: STORAGE_SET_STATE_GAS }),
      senderFrame({ target: pool5.address, data: encodeFunctionData({ abi: pool5Abi, functionName: 'withdraw', args: [root, nf, recipient, relayer, fee] }), execution: 60_000n, state: NEW_ACCOUNT_STATE }),
    ],
    signatures: [], fees: FEES, blobVersionedHashes: [],
  }
}

/** binding = keccak256(recipient || relayer || fee), as Pool5.yul computes it. */
export const bindingOf = (recipient: Address, relayer: Address, fee: bigint): Hex => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [recipient, relayer, fee]))
export { bytesToHex }
