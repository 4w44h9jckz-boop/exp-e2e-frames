// Experiment 32: the reference keystore, off chain. Two trees of depth 20, the registration tags, a
// queue of recoveries and a clock, with the same hashes the programs make (programs/lib.py).
//
// A cell is 16 bytes, two 64-bit limbs little-endian; a 32-byte value is two cells. H(x, y) is
// Keccak-256 of x || y, leanVM's KECCAK on two 32-byte operands. A version v is written g^v, g
// leanVM's generator of GF(2^64)^*; `gpow` (from the table tool) gives g^v's limb for v < 256.
import { keccak_256 } from '@noble/hashes/sha3'

export type Cell = [bigint, bigint]
const MASK = (1n << 64n) - 1n

export const TAU = { id: 1263730945n, pay: 1263730946n, leaf: 1263730947n, rev: 1263730948n, reg: 1263730949n, ent: 1263730950n, rot: 1263730951n }
export const DEPTH = 20
export const TOP = (1n << 128n) - 1n
export const RECOVERY_DELAY = 10

/** The 16 bytes of a cell, little-endian. */
export function bytesOfCell([c0, c1]: Cell): Uint8Array {
  const out = new Uint8Array(16)
  let v = c0 | (c1 << 64n)
  for (let i = 0; i < 16; i++) { out[i] = Number(v & 0xffn); v >>= 8n }
  return out
}
/** A 32-byte value's two cells. */
export function cellsOf(b: Uint8Array): [Cell, Cell] {
  if (b.length !== 32) throw new Error('a 32-byte value expected')
  const half = (o: number): Cell => {
    let v = 0n
    for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i])
    return [v & MASK, v >> 64n]
  }
  return [half(0), half(16)]
}
/** A cell holding the integer x < 2^128. */
export const cellOfInt = (x: bigint): Cell => [x & MASK, x >> 64n]
/** The integer a cell holds, its 16 bytes little-endian. */
export const intOfCell = ([c0, c1]: Cell): bigint => c0 | (c1 << 64n)
/** Two cells as one 32-byte value. */
export const pair = (a: Cell, b: Cell): Uint8Array => Buffer.concat([bytesOfCell(a), bytesOfCell(b)])
/** H(x, y) on 32-byte values. */
export const H = (x: Uint8Array, y: Uint8Array): Uint8Array => keccak_256(Buffer.concat([x, y]))
const tagged = (tau: bigint, x: Cell = [0n, 0n]) => pair([tau, 0n], x)

/** g^v's cell, from the tool's table. */
export const gCell = (gpow: string[], v: number): Cell => {
  if (v < 0 || v >= gpow.length) throw new Error(`version ${v} is outside the table`)
  return [BigInt(`0x${gpow[v]}`), 0n]
}

export const identityKey = (s: Uint8Array) => H(tagged(TAU.id), s)
export const accountOf = (s: Uint8Array, r: Uint8Array) => H(H(tagged(TAU.pay), identityKey(s)), r)
/** R = H(H([rule, 0], k0), H(k1, k2)), version 2a's key commitment; absent keys are 32 zero bytes. */
export const ruleDigest = (rule: bigint, keys: Uint8Array[]) => H(H(tagged(rule), keys[0]), H(keys[1], keys[2]))
export const leafOf = (gv: Cell, s: Uint8Array, rd: Uint8Array, rec: Uint8Array, salt: Uint8Array) =>
  H(H(tagged(TAU.leaf, gv), s), H(rd, H(rec, salt)))
export const revTagOf = (gv: Cell, s: Uint8Array) => H(tagged(TAU.rev, gv), s)
/** kappa: the revocation tag's first cell, as an unsigned 128-bit integer. */
export const kappaOf = (n: Uint8Array) => intOfCell(cellsOf(n)[0])
export const regTagOf = (s: Uint8Array) => H(tagged(TAU.reg), s)
export const entryOf = (a: bigint, b: bigint) => H(tagged(TAU.ent), pair(cellOfInt(a), cellOfInt(b)))
export const rotMessage = (mode: Cell, leaf: Uint8Array) => H(tagged(TAU.rot, mode), leaf)

const ZERO = new Uint8Array(32)
const zeros: Uint8Array[] = [ZERO]
for (let l = 0; l < DEPTH; l++) zeros.push(H(zeros[l], zeros[l]))

/** A Merkle path: at each level the two children in order, and the bit naming the node's side. */
export type Path = { kids: [Uint8Array, Uint8Array][]; bits: number[] }

/** A sparse binary Merkle tree of depth 20; an empty leaf is 32 zero bytes. */
export class Tree {
  private nodes = new Map<string, Uint8Array>()
  size = 0
  private at(level: number, index: number) { return this.nodes.get(`${level}:${index}`) ?? zeros[level] }
  set(index: number, leaf: Uint8Array) {
    if (index >= 2 ** DEPTH) throw new Error('the tree is full')
    this.nodes.set(`0:${index}`, leaf)
    let i = index
    for (let l = 0; l < DEPTH; l++) {
      const p = i >> 1
      this.nodes.set(`${l + 1}:${p}`, H(this.at(l, 2 * p), this.at(l, 2 * p + 1)))
      i = p
    }
    if (index >= this.size) this.size = index + 1
  }
  append(leaf: Uint8Array) { const i = this.size; this.set(i, leaf); return i }
  leaf(index: number) { return this.at(0, index) }
  root() { return this.at(DEPTH, 0) }
  path(index: number): Path {
    const kids: [Uint8Array, Uint8Array][] = []
    const bits: number[] = []
    let i = index
    for (let l = 0; l < DEPTH; l++) {
      const left = i & ~1
      kids.push([this.at(l, left), this.at(l, left + 1)])
      bits.push(i & 1)
      i >>= 1
    }
    return { kids, bits }
  }
  find(leaf: Uint8Array) {
    for (let i = 0; i < this.size; i++) if (Buffer.compare(Buffer.from(this.at(0, i)), Buffer.from(leaf)) === 0) return i
    return -1
  }
  clone() { const t = new Tree(); t.nodes = new Map(this.nodes); t.size = this.size; return t }
}

export type Entry = { a: bigint; b: bigint; index: number }
export type Queued = { n: Uint8Array; leaf: Uint8Array; at: number }
export class Refused extends Error {}

/** The keystore: the leaf tree, the revocation tree with its entries, the registration tags, a queue. */
export class Keystore {
  leaves = new Tree()
  revoked = new Tree()
  entries: Entry[] = []
  regTags = new Set<string>()
  queue: Queued[] = []
  clock = 0
  constructor(empty = false) {
    if (!empty) this.insertEntry({ a: 0n, b: TOP, index: this.revoked.append(entryOf(0n, TOP)) })
  }
  private insertEntry(e: Entry) { this.entries.push(e) }
  root() { return H(this.leaves.root(), this.revoked.root()) }
  /** The entry (a, b) with a < kappa < b, or undefined when kappa is a revocation key. */
  bracket(kappa: bigint) { return this.entries.find((e) => e.a < kappa && kappa < e.b) }
  isRevoked(n: Uint8Array) { return this.bracket(kappaOf(n)) === undefined }
  register(leaf: Uint8Array, q: Uint8Array) {
    const k = Buffer.from(q).toString('hex')
    if (this.regTags.has(k)) throw new Refused('registration tag already used')
    this.regTags.add(k)
    return this.leaves.append(leaf)
  }
  /** Insert a revocation tag and append the next leaf. */
  rotate(n: Uint8Array, leaf: Uint8Array) {
    const kappa = kappaOf(n)
    const e = this.bracket(kappa)
    if (!e) throw new Refused('the revocation tag is already in the tree')
    const b = e.b
    e.b = kappa
    this.revoked.set(e.index, entryOf(e.a, kappa))
    this.insertEntry({ a: kappa, b, index: this.revoked.append(entryOf(kappa, b)) })
    return this.leaves.append(leaf)
  }
  recover(n: Uint8Array, leaf: Uint8Array) {
    if (this.isRevoked(n)) throw new Refused('the revocation tag is already in the tree')
    this.queue.push({ n, leaf, at: this.clock })
  }
  private queued(n: Uint8Array, leaf: Uint8Array) {
    return this.queue.findIndex((q) => Buffer.compare(Buffer.from(q.n), Buffer.from(n)) === 0 && Buffer.compare(Buffer.from(q.leaf), Buffer.from(leaf)) === 0)
  }
  cancel(n: Uint8Array, leaf: Uint8Array) {
    const i = this.queued(n, leaf)
    if (i < 0) throw new Refused('no such queued recovery')
    this.queue.splice(i, 1)
  }
  execute(n: Uint8Array, leaf: Uint8Array) {
    const i = this.queued(n, leaf)
    if (i < 0) throw new Refused('no such queued recovery')
    if (this.clock < this.queue[i].at + RECOVERY_DELAY) throw new Refused('the recovery delay has not passed')
    this.queue.splice(i, 1)
    return this.rotate(n, leaf)
  }
  tick(n = 1) { this.clock += n }
  /** A copy whose later changes do not reach this one, for spends against an older root. */
  snapshot() {
    const k = new Keystore(true)
    k.leaves = this.leaves.clone()
    k.revoked = this.revoked.clone()
    k.entries = this.entries.map((e) => ({ ...e }))
    k.regTags = new Set(this.regTags)
    k.queue = this.queue.map((q) => ({ ...q }))
    k.clock = this.clock
    return k
  }
}
