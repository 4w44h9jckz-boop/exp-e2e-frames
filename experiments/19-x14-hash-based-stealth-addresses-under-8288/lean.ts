// Experiment 19 (X14): the host side of the leanVM programs in programs/. It builds each program's
// witness streams, computes the digest the program publishes, and runs prover/ on them.
//
// A leanVM cell is 16 bytes, little-endian, two 64-bit limbs; a digest is two cells. The VM's
// KECCAK is Keccak-256 over the message cells' bytes, checked here against leanVM's own known
// answer, H^3(5, 7) from its test programs (cellKnownAnswer below).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keccak_256 } from '@noble/hashes/sha3'

const here = new URL('.', import.meta.url).pathname
export const PROVER = join(here, 'prover/target/release/x14-prover')
export const PROGRAM = (name: string) => join(here, `programs/${name}.py`)

export type Cell = [bigint, bigint]
const MASK = (1n << 64n) - 1n
/** A 32-byte value as its two cells: bytes 0..16 and 16..32, each little-endian. */
export function cellsOf(b: Uint8Array): [Cell, Cell] {
  if (b.length !== 32) throw new Error('a digest is 32 bytes')
  const half = (o: number): Cell => {
    let v = 0n
    for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i])
    return [v & MASK, v >> 64n]
  }
  return [half(0), half(16)]
}
/** A small literal cell, as the program writes `x[0] = 1`: the integer in the low limb. */
export const literal = (x: bigint): Cell => [x & MASK, x >> 64n]
const bytesOfCell = ([c0, c1]: Cell) => {
  const out = new Uint8Array(16)
  let v = c0 | (c1 << 64n)
  for (let i = 0; i < 16; i++) { out[i] = Number(v & 0xffn); v >>= 8n }
  return out
}
/** The VM's KECCAK over a list of cells: Keccak-256 of their bytes. */
export const H = (...cells: Cell[]): Uint8Array => keccak_256(Buffer.concat(cells.map((c) => Buffer.from(bytesOfCell(c)))))
const H2 = (a: Uint8Array, b: Uint8Array) => H(...cellsOf(a), ...cellsOf(b))
const tag = (x: bigint) => { const t = new Uint8Array(32); t.set(bytesOfCell(literal(x)), 0); return t }

export function cellKnownAnswer(): boolean {
  let a: Cell[] = [literal(5n), literal(7n)]
  for (let i = 0; i < 3; i++) a = cellsOf(H(a[0], a[1], a[0], a[1]))
  return a[0][0] + (a[0][1] << 64n) === 27240554859721455327970068208906002034n && a[1][0] + (a[1][1] << 64n) === 119514610692047185288834508057685931752n
}

const hexCell = ([c0, c1]: Cell) => [c0.toString(16), c1.toString(16)]
export type Input = { public: [Cell, Cell]; witness: Record<string, Cell[][]>; logInvRate?: number }

/** Prove `program` on `input` with prover/, `repeat` measured passes after a warm-up. */
export function prove(program: string, input: Input, repeat = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'x14-'))
  const file = join(dir, 'input.json')
  writeFileSync(file, JSON.stringify({ public: input.public.map(hexCell), witness: Object.fromEntries(Object.entries(input.witness).map(([k, es]) => [k, es.map((e) => e.map(hexCell))])), logInvRate: input.logInvRate ?? 1 }))
  const out = execFileSync(PROVER, [PROGRAM(program), file, String(repeat)], { encoding: 'utf8', maxBuffer: 1 << 24 })
  return JSON.parse(out.trim().split('\n').pop()!) as { cycles: number; details: string; proofBytes: number; proveMs: number[]; warmupMs: number; verifyMs: number; verified: boolean; peakRssBytes: number; logInvRate: number }
}

// ---- version 1: the preimage spend ----

export const TAG_KEY = tag(1n)
export function v1(k: Uint8Array, r: Uint8Array, m: Uint8Array) {
  const K = H2(k, TAG_KEY)
  const C = H2(K, r)
  const T = H2(H2(k, r), m)
  const D = H2(H2(C, m), T)
  const input: Input = { public: cellsOf(D), witness: { k: [cellsOf(k)], r: [cellsOf(r)], m: [cellsOf(m)] } }
  return { K, C, T, D, input }
}

// ---- version 5: Tornado's statement in a Keccak tree ----

export const TAG_NF = tag(2n)
export const LEVELS = 20
export function zeros(): Uint8Array[] {
  const z = [keccak_256(new TextEncoder().encode('exp-e2e-frames/19/zero'))]
  for (let i = 0; i < LEVELS; i++) z.push(H2(z[i], z[i]))
  return z
}
export const leafOf = (ns: Uint8Array, s: Uint8Array) => H2(ns, s)
export const nullifierHashOf = (ns: Uint8Array) => H2(ns, TAG_NF)
export function treeOf(leaves: Uint8Array[]) {
  const z = zeros()
  const layers: Uint8Array[][] = [leaves]
  for (let l = 0; l < LEVELS; l++) {
    const up: Uint8Array[] = []
    for (let j = 0; j < layers[l].length; j += 2) up.push(H2(layers[l][j], layers[l][j + 1] ?? z[l]))
    layers.push(up)
  }
  return {
    root: layers[LEVELS][0] ?? z[LEVELS],
    path(index: number) {
      const sib: Uint8Array[] = []
      const bits: bigint[] = []
      for (let l = 0, i = index; l < LEVELS; l++, i >>= 1) { sib.push(layers[l][i ^ 1] ?? z[l]); bits.push(BigInt(i & 1)) }
      return { sib, bits }
    },
  }
}
export function v5(ns: Uint8Array, s: Uint8Array, binding: Uint8Array, tree: ReturnType<typeof treeOf>, index: number) {
  const nf = nullifierHashOf(ns)
  const D = H2(H2(tree.root, nf), binding)
  const { sib, bits } = tree.path(index)
  const input: Input = { public: cellsOf(D), witness: { ns: [cellsOf(ns)], s: [cellsOf(s)], binding: [cellsOf(binding)], path: [sib.flatMap((x) => cellsOf(x))], bits: [bits.map((b) => literal(b))] } }
  return { root: tree.root, nf, D, input }
}
