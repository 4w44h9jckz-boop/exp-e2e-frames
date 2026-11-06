// Experiment 26 (X19): the host side of the user's statement, programs/x19_transfer.py. It writes
// the tables into the template, builds a transfer's witness streams, computes the digest D that the
// rollup recomputes from public values, and proves with experiment 19's prover.
//
// Every hash here is keccak256 over 32-byte words, which is what leanVM's KECCAK over two digests'
// cells is (experiment 19's lean.ts checks that against leanVM's own known answer).
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Hex, bytesToHex, concatHex, hexToBytes, keccak256 } from 'viem'
import * as L from '../19-x14-hash-based-stealth-addresses-under-8288/lean.js'

const here = new URL('.', import.meta.url).pathname
const root = join(here, '../..')
export const TOOL = join(root, 'experiments/19-x14-hash-based-stealth-addresses-under-8288/prover/target/release/x19-tool')
const TEMPLATE = join(here, 'programs/x19_transfer.py')

type Tables = { gpow: string[]; hpow: [string, string, string][]; yInv: [string, string, string]; checks: Record<string, boolean> }
let tables: Tables | null = null
export function getTables(): Tables {
  if (!tables) {
    tables = JSON.parse(execFileSync(TOOL, ['tables'], { encoding: 'utf8' })) as Tables
    if (!Object.values(tables.checks).every(Boolean)) throw new Error(`x19-tool's checks failed: ${JSON.stringify(tables.checks)}`)
  }
  return tables
}

const lit = (c: [string, string, string]) => `f192(${c[0]},${c[1]},${c[2]})`

/** The instantiated program's text: the template with the tables written into its code lines. */
export function programText(): string {
  const t = getTables()
  const reps: [string, string][] = [
    ['Y_INV_PLACEHOLDER', lit(t.yInv)],
    ['HPOW_PLACEHOLDER', `[${t.hpow.map(lit).join(', ')}]`],
  ]
  return readFileSync(TEMPLATE, 'utf8').split('\n').map((l) => {
    if (l.trimStart().startsWith('#')) return l
    for (const [a, b] of reps) l = l.replaceAll(a, b)
    return l
  }).join('\n')
}

/** The program file under `dir`, written there, and its key: keccak256 of the file's bytes. */
export function writeProgram(dir: string): { path: string; key: Hex } {
  mkdirSync(dir, { recursive: true })
  const text = programText()
  const path = join(dir, 'x19_transfer.py')
  writeFileSync(path, text)
  return { path, key: keccak256(new TextEncoder().encode(text)) }
}

/** H over 32-byte words. */
export const H = (...ws: Hex[]): Hex => keccak256(concatHex(ws))
/** B(x): x in the first eight bytes, little-endian, then zeros. */
export function B(x: bigint): Hex {
  if (x < 0n || x >= 1n << 64n) throw new Error('B(x) takes a 64-bit unsigned integer')
  const b = new Uint8Array(32)
  for (let i = 0; i < 8; i++) b[i] = Number((x >> BigInt(8 * i)) & 0xffn)
  return bytesToHex(b)
}

export type Transfer = {
  /** keccak256(key0 || key1 || recipient), the leaf's keys. */
  kh: Hex
  balance: bigint
  amount: bigint
  fee: bigint
  s0: Hex
  s1: Hex
  r: Hex
  chan: Hex
  to: Hex
  expiry: Hex
  nullifier: Hex
}

/** Everything public a transfer publishes, and what the rollup recomputes D from. */
export function publicOf(t: Transfer) {
  const newBalance = t.balance - t.amount - t.fee
  const c0 = H(B(t.balance), t.s0)
  const c1 = H(B(newBalance < 0n ? 0n : newBalance), t.s1)
  const amountCommit = H(B(t.amount), t.r)
  const oldLeaf = H(t.kh, c0)
  const newLeaf = H(t.kh, c1)
  const transferLeaf = H(H(H(t.chan, c1), H(t.to, amountCommit)), H(H(B(t.fee), t.expiry), t.nullifier))
  const D = H(H(oldLeaf, newLeaf), transferLeaf)
  return { newBalance, c0, c1, amountCommit, oldLeaf, newLeaf, transferLeaf, D }
}

const hexCell = ([a, b]: L.Cell) => [a.toString(16), b.toString(16)]
const word = (w: Hex) => L.cellsOf(hexToBytes(w)).map(hexCell)
const intCell = (x: bigint) => [(x & ((1n << 64n) - 1n)).toString(16), '0']
const bytesEntry = (x: bigint) => {
  const g = getTables().gpow
  return Array.from({ length: 8 }, (_, p) => [g[Number((x >> BigInt(8 * p)) & 0xffn)], '0'])
}

/** The prover's input for a transfer. `newBalance` may be given to build a witness that lies. */
export function inputOf(t: Transfer, o: { newBalance?: bigint; proofOut?: string } = {}) {
  const pub = publicOf(t)
  const nb = o.newBalance ?? pub.newBalance
  return {
    public: L.cellsOf(hexToBytes(pub.D)).map(hexCell),
    witness: {
      num: [[intCell(t.balance), intCell(t.amount), intCell(t.fee), intCell(nb)]],
      bytes: [bytesEntry(t.balance), bytesEntry(t.amount), bytesEntry(t.fee), bytesEntry(nb)],
      w: [t.kh, t.s0, t.s1, t.r, t.chan, t.to, t.expiry, t.nullifier].map(word),
    },
    sphincs: [],
    logInvRate: 1,
    ...(o.proofOut ? { proofOut: o.proofOut } : {}),
  }
}

export type Proved = L.Proved
/** Prove `program` (the instantiated file) on a transfer's input; a refused witness is `{ error }`. */
export function proveTransfer(program: string, input: ReturnType<typeof inputOf>, repeat = 1): Proved | { error: string } {
  const dir = mkdtempSync(join(tmpdir(), 'x19-'))
  const file = join(dir, 'input.json')
  writeFileSync(file, JSON.stringify(input))
  try {
    const out = execFileSync(L.PROVER, [program, file, String(repeat)], { encoding: 'utf8', maxBuffer: 1 << 24 })
    return JSON.parse(out.trim().split('\n').pop()!) as Proved
  } catch (e) {
    const out = String((e as { stdout?: string }).stdout ?? '')
    if (out.includes('"error"')) return JSON.parse(out.trim().split('\n').pop()!) as { error: string }
    throw e
  }
}

/** `x14-prover verify` on a proof against D, as the patched builder checks a leanSTARK dependency. */
export function verifyTransfer(program: string, D: Hex, proofFile: string): { verified: boolean; verifyMs?: number; error?: string } {
  const dir = mkdtempSync(join(tmpdir(), 'x19v-'))
  const pub = join(dir, 'public.json')
  writeFileSync(pub, JSON.stringify(L.cellsOf(hexToBytes(D)).map(hexCell)))
  try {
    return JSON.parse(execFileSync(L.PROVER, ['verify', program, pub, proofFile], { encoding: 'utf8' }).trim().split('\n').pop()!)
  } catch (e) {
    const out = String((e as { stdout?: string }).stdout ?? '')
    return out.includes('{') ? JSON.parse(out.trim().split('\n').pop()!) : { verified: false, error: String(e).slice(0, 200) }
  }
}
