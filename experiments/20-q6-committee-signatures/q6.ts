// Experiment 20 (Q6): the committees' keys, the contracts, the triples and the transactions.
// Every member's leanSPHINCS seed derives from PRIVATE_KEY and a label, so every script sees the
// same committee; no seed is printed or recorded. Addresses come from CREATE2 with label salts.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Address, type Hex, concatHex, encodeFunctionData, hexToBigInt, keccak256, numberToHex, pad, parseAbi, toHex } from 'viem'
import { create2Address, deployFrame, saltOf } from '../../src/exp-frames/deploy.js'
import { Approve, type Frame, type FrameTx, type FrameTxFees, NEW_ACCOUNT_STATE_GAS, STORAGE_SET_STATE_GAS, senderFrame, verifyFrame } from '../../src/exp-frames/frametx/index.js'
import * as L from '../19-x14-hash-based-stealth-addresses-under-8288/lean.js'
import * as X11 from '../16-x11-paid-reads-settled/x11.js'
// @ts-expect-error: a plain ES module
import { compile } from './contracts/compile.mjs'

export const DIR = 'experiments/20-q6-committee-signatures'
export const word = (x: bigint | number) => numberToHex(BigInt(x), { size: 32 })
export const DEPLOYMENT = process.env.Q6_DEPLOYMENT ?? 'd1'
const tag = (l: string) => `exp-e2e-frames/20/${DEPLOYMENT}/${l}`
export const FEES: FrameTxFees = { maxPriorityFeePerGas: 1n, maxFeePerGas: 100n, maxFeePerBlobGas: 0n }

// ---- the committees ----

/** A member's 32-byte leanSPHINCS seed: never printed, never recorded. */
export const seedOf = (base: Hex, l: string): Uint8Array => Buffer.from(keccak256(concatHex([base, toHex(tag(`seed/${l}`))])).slice(2), 'hex')
export type Member = { label: string; seed: Uint8Array; key: Hex }
export function committeeOf(base: Hex, arm: string, n: number): { members: Member[]; outsider: Member } {
  const make = (l: string): Member => { const seed = seedOf(base, `${arm}/${l}`); return { label: l, seed, key: bytesToHexS(L.sphincsKey(seed)) } }
  return { members: Array.from({ length: n }, (_, i) => make(`member/${i}`)), outsider: make('outsider') }
}
const bytesToHexS = (b: Uint8Array): Hex => `0x${Buffer.from(b).toString('hex')}`

// ---- EIP-8288 ----

export const LEANSPHINCS_SCHEME = 0x10n
export const LEANSPHINCS_VERIFICATION_GAS = 3_000
export const triple = (m: Hex, key: Hex): Hex => concatHex([word(LEANSPHINCS_SCHEME), m, key])
/** A signer of a statement: who, and the message the signature is on (m unless a refusal says otherwise). */
export type Signer = { member: Member; on: Hex }
export const triplesOf = (signers: Signer[]): Hex => concatHex(signers.map((s) => triple(s.on, s.member.key)))
export const countOf = (triples: Hex) => (triples.length - 2) / 192
/** EIP-8288's dependency verification frame (mode 4): no target, its execution the declared price. */
export function depFrame(triples: Hex): Frame {
  return { mode: 4, flags: 0, target: null, limits: { execution: BigInt(countOf(triples) * LEANSPHINCS_VERIFICATION_GAS), state: 0n }, value: 0n, data: triples }
}
/** Where the triples go: a dependency frame of their own (local, EIP-8288 as written), or the end of VERIFY's data (testnet, modelled). */
export type Placement = 'dep-frame' | 'modelled'
export function placed(verifyData: Hex, triples: Hex, placement: Placement): { verify: Hex; between: Frame[] } {
  return placement === 'dep-frame' ? { verify: verifyData, between: [depFrame(triples)] } : { verify: concatHex([verifyData, triples]), between: [] }
}
/** The members an observer reads from a transaction's own frames: each triple's key, as a member index (or 'outsider'). */
export function signersRead(tx: FrameTx, keys: Hex[], skipBytes: number): { frame: number; signers: (number | string)[]; messages: Hex[] } {
  const dep = tx.frames.findIndex((f) => f.mode === 4)
  const f = dep >= 0 ? dep : 0
  // In VERIFY's data the triples follow `skipBytes` bytes of the contract's own words.
  const data = (dep >= 0 ? tx.frames[f].data : `0x${tx.frames[0].data.slice(2 + 2 * skipBytes)}`) as Hex
  const n = (data.length - 2) / 192
  const signers: (number | string)[] = []
  const messages: Hex[] = []
  for (let i = 0; i < n; i++) {
    const t = data.slice(2 + i * 192, 2 + (i + 1) * 192)
    if (BigInt(`0x${t.slice(0, 64)}`) !== LEANSPHINCS_SCHEME) continue
    messages.push(`0x${t.slice(64, 128)}`)
    const k = keys.indexOf(`0x${t.slice(128)}` as Hex)
    signers.push(k >= 0 ? k : 'outsider')
  }
  return { frame: f, signers, messages }
}

// ---- leanVM's aggregation, run by experiment 19's prover ----

export function aggregate(signed: L.Signed[]) {
  const dir = mkdtempSync(join(tmpdir(), 'q6-'))
  const claims = join(dir, 'claims.json')
  const out = join(dir, 'aggregate.bin')
  writeFileSync(claims, JSON.stringify(signed))
  const a = JSON.parse(execFileSync(L.PROVER, ['aggregate', claims, out], { encoding: 'utf8', maxBuffer: 1 << 24 }).trim().split('\n').pop()!)
  const check = join(dir, 'check.json')
  writeFileSync(check, JSON.stringify(signed.map((s) => ({ publicKey: s.publicKey.replace(/^0x/, ''), message: s.message.replace(/^0x/, '') }))))
  const t = Date.now()
  const v = execFileSync(L.PROVER, ['verify-aggregate', out, check], { encoding: 'utf8' }).trim()
  return { claims: a.claims as number, proofBytes: a.proofBytes as number, aggregateMs: a.aggregateMs as number, peakRssBytes: a.peakRssBytes as number, verifyMs: Date.now() - t, verified: !v.includes('"error"'), verifyOutput: v.slice(0, 200) }
}

// ---- contracts ----

const fixed = (initcode: Hex, l: string, value = 0n) => {
  const code = initcode.toLowerCase() as Hex
  const salt = saltOf(tag(l))
  const d = deployFrame(code, salt).frame
  return { label: l, initcode: code, salt, address: create2Address(code, salt), deploy: { ...d, value } as Frame }
}
const committeeWords = (keys: Hex[], quorum: number) => [...keys, word(quorum), word(keys.length)]
export const codes = { board: compile('NamedResultBoard') as Hex, vault: compile('NamedExitVault') as Hex, pool: compile('NamedReadPool') as Hex }
for (const [n, c] of Object.entries({ board: 'NamedResultBoard', vault: 'NamedExitVault', pool: 'NamedReadPool' })) {
  if (readFileSync(new URL(`contracts/${c}.hex`, import.meta.url), 'utf8').trim() !== codes[n as keyof typeof codes]) throw new Error(`${c}.hex is stale`)
}

// X5: the result board, 3 of 4.
export const fixedBoard = (keys: Hex[], l: string) => fixed(concatHex([codes.board, ...committeeWords(keys, 3)]), l)
export const boardOf = (keys: Hex[]) => fixedBoard(keys, 'board')
export const RESULT_TAG = keccak256(toHex('exp-e2e-frames/20/result'))
export const resultMessage = (chainId: bigint, request: Hex, handle: Hex, value: bigint): Hex => keccak256(concatHex([RESULT_TAG, word(chainId), request, handle, word(value)]))
const boardAbi = parseAbi(['function record(bytes32 request, bytes32 handle, uint256 value)'])
export function resultTx(chainId: bigint, board: Address, request: Hex, handle: Hex, value: bigint, triples: Hex, placement: Placement): FrameTx {
  const p = placed(concatHex([request, handle, word(value)]), triples, placement)
  return {
    chainId, nonceKeys: [hexToBigInt(request)], nonceSeq: 0n, sender: board,
    frames: [
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, data: p.verify, execution: 100_000n, state: STORAGE_SET_STATE_GAS }),
      ...p.between,
      senderFrame({ target: board, data: encodeFunctionData({ abi: boardAbi, functionName: 'record', args: [request, handle, value] }), execution: 30_000n, state: 0n }),
    ],
    signatures: [], fees: FEES, blobVersionedHashes: [],
  }
}

// X11: the read pool, 3 of 4, with ReadPool's price, slash amount, digests and words less the signatures.
export const poolOf = (keys: Hex[]) => {
  const salt = saltOf(tag('pool/salt'))
  return fixed(concatHex([codes.pool, word(X11.PRICE), word(X11.SLASH), salt, ...committeeWords(keys, 3)]), 'pool')
}
const SENDER_GAS = { execution: 120_000n, state: NEW_ACCOUNT_STATE_GAS + 2n * STORAGE_SET_STATE_GAS }
export function poolTx(chainId: bigint, pool: Address, key: bigint, fn: 'settle' | 'refund' | 'slash', w: bigint[], triples: Hex, placement: Placement): FrameTx {
  const p = placed('0x', triples, placement)
  return {
    chainId, nonceKeys: [key], nonceSeq: 0n, sender: pool,
    frames: [
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, data: p.verify, execution: 100_000n, state: STORAGE_SET_STATE_GAS }),
      ...p.between,
      senderFrame({ target: pool, data: encodeFunctionData({ abi: X11.poolAbi, functionName: fn, args: [w] }), ...SENDER_GAS }),
    ],
    signatures: [], fees: FEES, blobVersionedHashes: [],
  }
}
export const settleWords = (b: X11.Batch, fee = X11.FEE) => [hexToBigInt(b.server), b.epoch, BigInt(b.serials.length), hexToBigInt(X11.rootOf(b.serials)), fee]
export const refundWords = (serial: Hex, recipient: Address, fee = X11.FEE) => [hexToBigInt(serial), hexToBigInt(recipient), fee]
const ZERO = word(0)
const batchWords = (b: X11.Batch) => [hexToBigInt(b.server), b.epoch, BigInt(b.serials.length), hexToBigInt(X11.rootOf(b.serials))]
const pathWords = (serials: Hex[], i: number) => (i < 0 ? Array(8).fill(ZERO) : X11.pathOf(serials, i)).map((h: Hex) => hexToBigInt(h))
export function slashTwoBatches(member: number, reporter: Address, a: X11.Batch, b: X11.Batch, serial: Hex, fee = X11.FEE) {
  const ia = a.serials.indexOf(serial)
  const ib = b.serials.indexOf(serial)
  return [BigInt(member), hexToBigInt(reporter), fee, 1n, ...batchWords(a), ...batchWords(b), hexToBigInt(serial), BigInt(Math.max(ia, 0)), BigInt(Math.max(ib, 0)), ...pathWords(a.serials, ia), ...pathWords(b.serials, ib)]
}
export function slashBatchAndRefund(member: number, reporter: Address, a: X11.Batch, serial: Hex, recipient: Address, fee = X11.FEE) {
  const ia = a.serials.indexOf(serial)
  return [BigInt(member), hexToBigInt(reporter), fee, 2n, ...batchWords(a), hexToBigInt(serial), hexToBigInt(recipient), BigInt(Math.max(ia, 0)), ...pathWords(a.serials, ia)]
}
const pairOf = (x: Hex, y: Hex) => hexToBigInt(keccak256(concatHex([x, y])))
export function slashKeyOf(member: number, a: Hex, b: Hex, kind: 1 | 2) {
  const other = kind === 2 ? pairOf(a, b) : hexToBigInt(a) < hexToBigInt(b) ? pairOf(a, b) : pairOf(b, a)
  return X11.keyFor(3n, BigInt(member), other)
}

export { X11, L, pad }
