// Experiment 18 (X13): the contracts, the keys, the proof, and the registry's spend transaction.
// Addresses come from CREATE2 with label salts, and every key and note secret from PRIVATE_KEY and
// a label, so every script sees the same parties. Nothing secret is printed or recorded.
import { readFileSync } from 'node:fs'
import * as snarkjs from 'snarkjs'
import { type Address, type Hex, concatHex, encodeFunctionData, hexToBigInt, keccak256, numberToHex, pad, parseAbi, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { compileYul } from '../../src/exp-frames/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/exp-frames/deploy.js'
import { Approve, type FrameTx, type FrameTxFees, STORAGE_SET_STATE_GAS, senderFrame, verifyFrame } from '../../src/exp-frames/frametx/index.js'
import { FIELD, H, HASHER, HASHER_INITCODE, proofWords, treeOf } from '../15-x10-out-and-back/x10.js'

export const DIR = 'experiments/18-x13-out-of-band-delivery'
const here = (f: string) => new URL(f, import.meta.url).pathname
export const word = (x: bigint | number) => numberToHex(BigInt(x), { size: 32 })

/** Which deployment: every salt and every key carries it, so a stopped pass reruns on fresh ones. */
export const DEPLOYMENT = process.env.X13_DEPLOYMENT ?? 'd1'
const tag = (l: string) => `exp-e2e-frames/18/${DEPLOYMENT}/${l}`
export const FEES: FrameTxFees = { maxPriorityFeePerGas: 1n, maxFeePerGas: 100n, maxFeePerBlobGas: 100n }

// ---- keys and secrets ----

export const keyOf = (base: Hex, l: string): Hex => keccak256(concatHex([base, toHex(tag(`key/${l}`))]))
export const addressOf = (base: Hex, l: string): Address => privateKeyToAddress(keyOf(base, l))
/** A field element from PRIVATE_KEY and a label. */
export const fieldOf = (base: Hex, l: string): bigint => hexToBigInt(keyOf(base, `field/${l}`)) % FIELD
export const bytesOf = (base: Hex, l: string, n: number): Uint8Array => {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i += 32) out.set(Buffer.from(keyOf(base, `bytes/${l}/${i / 32}`).slice(2), 'hex').subarray(0, Math.min(32, n - i)), i)
  return out
}

// ---- contracts ----

type Vkey = { nPublic: number; vk_alpha_1: string[]; vk_beta_2: string[][]; vk_gamma_2: string[][]; vk_delta_2: string[][]; IC: string[][] }
export const VKEY = JSON.parse(readFileSync(here('build/deliver.vkey.json'), 'utf8')) as Vkey
const g1 = (p: string[]) => [word(BigInt(p[0])), word(BigInt(p[1]))]
const g2 = (p: string[][]) => [word(BigInt(p[0][1])), word(BigInt(p[0][0])), word(BigInt(p[1][1])), word(BigInt(p[1][0]))]
const fixed = (initcode: Hex, l: string) => {
  const code = initcode.toLowerCase() as Hex
  const salt = saltOf(tag(l))
  return { label: l, initcode: code, salt, address: create2Address(code, salt), deploy: deployFrame(code, salt).frame }
}
const verifierCode = compileYul('experiments/15-x10-out-and-back/contracts/Groth16Verifier.yul')
export const verifier = fixed(concatHex([verifierCode, ...g1(VKEY.vk_alpha_1), ...g2(VKEY.vk_beta_2), ...g2(VKEY.vk_gamma_2), ...g2(VKEY.vk_delta_2), ...VKEY.IC.flatMap(g1), word(VKEY.nPublic)]), 'verifier')
const registryCode = compileYul(`${DIR}/contracts/Registry18.yul`)
export const registry = fixed(concatHex([registryCode, pad(verifier.address), pad(HASHER), saltOf(tag('registry/word'))]), 'registry')
export { HASHER, HASHER_INITCODE }

export const registryAbi = parseAbi([
  'function deposit(bytes32 c) payable',
  'function deliver(uint256[] w)',
  'function tick()',
  'function root() view returns (uint256)',
  'function leafCount() view returns (uint256)',
  'function clock() view returns (uint256)',
  'function isKnownRoot(bytes32 root) view returns (uint256)',
  'event Deposited(bytes32 c, uint256 index, uint256 t0)',
  'event Spent(uint256 indexed nullifier, bytes32 outCommitment, uint256 index, uint256 t0)',
])

// ---- the proof ----

export type Witness = {
  root: bigint; nullifier: bigint; tNow: bigint; outCommitment: bigint
  value: bigint; pkR: bigint; d: bigint; n: bigint; s: bigint; h: bigint; T: bigint; refund: bigint; t0: bigint
  branch: bigint; sk: bigint; outInner: bigint; pathElements: bigint[]; pathIndices: bigint[]
}
const decimal = (x: Record<string, unknown>) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)]))

/** Prove with snarkjs, check the proof against the key, and return the verifier's eight words. */
export async function prove(w: Witness): Promise<{ proof: bigint[]; ms: number }> {
  const t0 = Date.now()
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(decimal(w), here('build/deliver_js/deliver.wasm'), here('build/deliver.zkey'))
  const ms = Date.now() - t0
  if (!(await snarkjs.groth16.verify(VKEY, publicSignals, proof))) throw new Error('snarkjs produced a proof its own key refuses')
  const want = [w.root, w.nullifier, w.tNow, w.outCommitment]
  if ((publicSignals as string[]).map(BigInt).some((x, i) => x !== want[i])) throw new Error('public signals differ')
  return { proof: proofWords(proof), ms }
}

/** Every leaf the registry has inserted, in order, and the tree they make. */
export function treeFrom(leaves: bigint[]) {
  return treeOf(leaves)
}

// ---- the spend ----

export const VERIFY_EXECUTION = 400_000n
export const SENDER_GAS = { execution: 1_300_000n, state: 3n * STORAGE_SET_STATE_GAS }

/** The registry as sender and payer: VERIFY, then deliver(w), the nullifier the one nonce key. */
export function spendTx(chainId: bigint, w: bigint[]): FrameTx {
  return {
    chainId,
    nonceKeys: [w[1]],
    nonceSeq: 0n,
    sender: registry.address,
    frames: [
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, execution: VERIFY_EXECUTION, state: STORAGE_SET_STATE_GAS }),
      senderFrame({ target: registry.address, data: encodeFunctionData({ abi: registryAbi, functionName: 'deliver', args: [w] }), ...SENDER_GAS }),
    ],
    signatures: [],
    fees: FEES,
    blobVersionedHashes: [],
  }
}

export { FIELD, H }
