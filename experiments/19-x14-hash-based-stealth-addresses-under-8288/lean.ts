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
export type Signed = { publicKey: string; signature: string; message: string }
export type Input = { public: [Cell, Cell]; witness: Record<string, Cell[][]>; sphincs?: Signed[]; logInvRate?: number; proofOut?: string }

/** Prove `program` on `input` with prover/, `repeat` measured passes after a warm-up. */
export function prove(program: string, input: Input, repeat = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'x14-'))
  const file = join(dir, 'input.json')
  writeFileSync(file, JSON.stringify({ public: input.public.map(hexCell), witness: Object.fromEntries(Object.entries(input.witness).map(([k, es]) => [k, es.map((e) => e.map(hexCell))])), sphincs: input.sphincs ?? [], logInvRate: input.logInvRate ?? 1, ...(input.proofOut ? { proofOut: input.proofOut } : {}) }))
  const out = execFileSync(PROVER, [PROGRAM(program), file, String(repeat)], { encoding: 'utf8', maxBuffer: 1 << 24 })
  return JSON.parse(out.trim().split('\n').pop()!) as Proved
}
export type Proved = { cycles: number; details: string; proofBytes: number; proveMs: number[]; warmupMs: number; verifyMs: number; verified: boolean; peakRssBytes: number; logInvRate: number; bytecodeLen: number }
/** As prove, but a witness the program refuses comes back as `{ error }` rather than a throw. */
export function tryProve(program: string, input: Input): Proved | { error: string } {
  try {
    return prove(program, input, 0)
  } catch (e) {
    const out = String((e as { stdout?: string }).stdout ?? '')
    if (out.includes('"error"')) return JSON.parse(out.trim().split('\n').pop()!) as { error: string }
    throw e
  }
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

// ---- version 2a: the rule and its keys private, leanSPHINCS verified in circuit ----

/** The rules programs/v2a_rules.py knows: key 0 alone, or two different keys of three. */
export const RULE_ONE = 1n
export const RULE_TWO_OF_THREE = 2n
const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}`

/** The owner's signer: the key from a 32-byte seed signs m. Only this call holds the seed. */
export function sign(seed: Uint8Array, m: Uint8Array): Signed & { verified: boolean; signMs: number } {
  const out = JSON.parse(execFileSync(PROVER, ['sphincs', hex(seed), hex(m)], { encoding: 'utf8' }).trim())
  return { publicKey: `0x${out.publicKey}`, signature: `0x${out.signature}`, message: hex(m), verified: out.verified, signMs: out.signMs }
}
/** A leanSPHINCS public key (its root, then its public parameter) from a 32-byte seed. */
export const sphincsKey = (seed: Uint8Array): Uint8Array => Buffer.from(sign(seed, new Uint8Array(32)).publicKey.slice(2), 'hex')
/** K = H(H(rule, key 0), H(key 1, key 2)); a rule of one key leaves keys 1 and 2 zero. */
export const ruleKeyOf = (rule: bigint, keys: Uint8Array[]) => H2(H2(tag(rule), keys[0]), H2(keys[1], keys[2]))
/**
 * A version 2a spend: the keys at `signers` (indices into `keys`, with their signatures, which need
 * not be on m) sign m, and the proof publishes D = H(H(C, m), T) with C = H(K, r) and
 * T = H(H(r, K), m).
 */
export function v2a(rule: bigint, keys: Uint8Array[], r: Uint8Array, m: Uint8Array, signers: { index: number; signed: Signed }[]) {
  const K = ruleKeyOf(rule, keys)
  const C = H2(K, r)
  const T = H2(H2(r, K), m)
  const D = H2(H2(C, m), T)
  const input: Input = {
    public: cellsOf(D),
    witness: { rule: [[literal(rule)]], keys: [keys.flatMap((k) => cellsOf(k))], r: [cellsOf(r)], m: [cellsOf(m)], signer: signers.map((s) => [literal(1n << BigInt(s.index))]) },
    // Each signature's witness is built at the message it signs, so a signature on another message
    // reaches the circuit and is refused there.
    sphincs: signers.map((s) => s.signed),
  }
  return { K, C, T, D, input }
}

// ---- version 2b: one interpreter over a committed rule (Amendment 3) ----

export const SLOT_EMPTY = 0n
export const SLOT_KEY = 1n
export const SLOT_PREIMAGE = 2n
export type Slot = { type: bigint; value: Uint8Array }
/** A rule: a threshold and three slots, a key's value its 32 bytes, a preimage key's H(k, TAG_KEY). */
export type Rule = { t: number; slots: [Slot, Slot, Slot] }
export const preimageKeyOf = (k: Uint8Array) => H2(k, TAG_KEY)
const gPow = (t: number) => literal(1n << BigInt(t))
/** K = H(H(H(g^t, type 0, type 1, type 2), H(value 0, value 1)), value 2). */
export function interpretedKeyOf(rule: Rule): Uint8Array {
  const a = H(gPow(rule.t), literal(rule.slots[0].type), literal(rule.slots[1].type), literal(rule.slots[2].type))
  return H2(H2(a, H2(rule.slots[0].value, rule.slots[1].value)), rule.slots[2].value)
}
/**
 * A version 2b spend: the slots at `used` satisfied, a key's by its signature (given, on m), a
 * preimage key's by its k; the proof publishes D = H(H(C, m), T) as versions 1 and 2a do.
 */
export function v2b(rule: Rule, r: Uint8Array, m: Uint8Array, used: { index: number; signed?: Signed; k?: Uint8Array }[]) {
  const K = interpretedKeyOf(rule)
  const C = H2(K, r)
  const T = H2(H2(r, K), m)
  const D = H2(H2(C, m), T)
  const use = [0, 1, 2].map((i) => literal(used.some((u) => u.index === i) ? 1n : 0n))
  const inOrder = [...used].sort((x, y) => x.index - y.index)
  const input: Input = {
    public: cellsOf(D),
    witness: {
      t: [[gPow(rule.t)]], types: [rule.slots.map((s) => literal(s.type))], values: [rule.slots.flatMap((s) => cellsOf(s.value))],
      use: [use], r: [cellsOf(r)], m: [cellsOf(m)],
      preimage: inOrder.filter((u) => u.k).map((u) => cellsOf(u.k!)),
    },
    sphincs: inOrder.filter((u) => u.signed).map((u) => u.signed!),
  }
  return { K, C, T, D, input }
}
