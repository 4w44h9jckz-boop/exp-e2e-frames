// Experiment 32: the host side. It assembles the three programs, builds each statement's witness
// streams from the reference keystore, and runs experiment 19's prover on them.
//
// Every program is assembled from experiment 19's version 2a file, from which it takes the
// leanSPHINCS verifier, lifted verbatim from leanVM by lift.py, and verify_one, then
// programs/lib.py and the entry point, with the tables filled in from tool/. A program's key is
// keccak256 of the assembled file's bytes, as docs/leanvm-program-layout.md fixes it.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keccak_256 } from '@noble/hashes/sha3'
import {
  type Cell, type Keystore, type Path, accountOf, cellOfInt, cellsOf, gCell, kappaOf, leafOf, pair, regTagOf, revTagOf, rotMessage, ruleDigest, H,
} from './keystore.js'

const here = new URL('.', import.meta.url).pathname
const X19 = join(here, '../19-x14-hash-based-stealth-addresses-under-8288')
export const PROVER = join(X19, 'prover/target/release/x14-prover')
export const TOOL = join(here, 'tool/target/release/x32-tool')
export const BUILD = join(here, 'build')
export type Program = 'spend' | 'register' | 'rotate'

export type Tables = { gpow: string[]; hpow: [string, string, string][]; yInv: [string, string, string]; checks: Record<string, boolean> }
let tablesCache: Tables | undefined
export function tables(): Tables {
  tablesCache ??= JSON.parse(execFileSync(TOOL, ['tables'], { encoding: 'utf8', maxBuffer: 1 << 24 }).trim()) as Tables
  return tablesCache
}
const lit = (c: [string, string, string]) => `f192(${c[0]},${c[1]},${c[2]})`

/** The lifted verifier and verify_one, cut from version 2a's file at its markers. */
export function liftedFromV2a(): string {
  const src = readFileSync(join(X19, 'programs/v2a_rules.py'), 'utf8')
  const begin = src.indexOf('# ---- LIFTED: begin')
  const end = src.indexOf('# ---- LIFTED: end')
  const vo = src.indexOf('def verify_one(')
  const main = src.indexOf('def main():')
  if (begin < 0 || end < begin || vo < end || main < vo) throw new Error('version 2a has moved its markers')
  return src.slice(begin, end) + '# ---- LIFTED: end\n\n\n' + src.slice(vo, main)
}

/** Assemble one program, write it under build/, and return its path, its bytes' keccak and its size. */
export function assemble(name: Program) {
  const t = tables()
  const lifted = liftedFromV2a()
  if (!lifted.includes(`Y_INV = ${lit(t.yInv)}`)) throw new Error('the lifted Y_INV is not the tool\'s')
  const lib = readFileSync(join(here, 'programs/lib.py'), 'utf8').replace('HPOW_PLACEHOLDER', `[${t.hpow.map(lit).join(', ')}]`)
  // leanVM takes every module constant before the first function, so lib.py's constants go
  // first, then the lifted verifier (its own constants, then its functions), then lib.py's functions.
  const firstFn = lib.search(/^(@inline|def )/m)
  const libConsts = lib.slice(0, firstFn)
  const libFns = lib.slice(firstFn)
  const entry = readFileSync(join(here, `programs/${name}.py`), 'utf8')
  const head = entry.split('\n').filter((l) => l.startsWith('#')).join('\n')
  const body = entry.split('\n').filter((l) => !l.startsWith('#')).join('\n')
  const file = `${head}\n#\n# Assembled by experiment 32's x32.ts: programs/lib.py's constants with its tables filled in,\n# experiment 19's lifted leanSPHINCS verifier and verify_one, lib.py's functions, and this entry\n# point.\nfrom snark_lib import *\n\n${libConsts}\n${lifted}\n${libFns}\n${body}`
  if (!existsSync(BUILD)) mkdirSync(BUILD)
  const path = join(BUILD, `${name}.py`)
  writeFileSync(path, file)
  return { path, key: `0x${Buffer.from(keccak_256(Buffer.from(file))).toString('hex')}`, bytes: Buffer.byteLength(file) }
}

const hexCell = ([c0, c1]: Cell) => [c0.toString(16), c1.toString(16)]
export type Signed = { publicKey: string; signature: string; message: string }
export type Input = { public: [Cell, Cell]; witness: Record<string, Cell[][]>; sphincs: Signed[]; proofOut?: string }
export type Proved = { cycles: number; details: string; proofBytes: number; proveMs: number[]; warmupMs: number; verifyMs: number; verified: boolean; peakRssBytes: number; logInvRate: number; bytecodeLen: number }

/** Prove `path` on `input`, `repeat` measured passes after a warm-up; a refused witness is `{ error }`. */
export function prove(path: string, input: Input, repeat = 0): Proved | { error: string } {
  const dir = mkdtempSync(join(tmpdir(), 'x32-'))
  const file = join(dir, 'input.json')
  writeFileSync(file, JSON.stringify({
    public: input.public.map(hexCell),
    witness: Object.fromEntries(Object.entries(input.witness).map(([k, es]) => [k, es.map((e) => e.map(hexCell))])),
    sphincs: input.sphincs,
    logInvRate: 1,
    ...(input.proofOut ? { proofOut: input.proofOut } : {}),
  }))
  try {
    const out = execFileSync(PROVER, [path, file, String(repeat)], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] })
    return JSON.parse(out.trim().split('\n').pop()!) as Proved
  } catch (e) {
    const out = String((e as { stdout?: string }).stdout ?? '')
    if (out.includes('"error"')) return JSON.parse(out.trim().split('\n').pop()!) as { error: string }
    const err = String((e as { stderr?: string }).stderr ?? '')
    return { error: `prover exited: ${err.trim().split('\n').slice(-3).join(' | ')}` }
  }
}

/** Check a kept proof against public values, as a verifier holding only those would. */
export function verifyAgainst(path: string, pub: [Cell, Cell], proofFile: string): { verified: boolean; verifyMs?: number; error?: string } {
  const dir = mkdtempSync(join(tmpdir(), 'x32v-'))
  const file = join(dir, 'public.json')
  writeFileSync(file, JSON.stringify(pub.map(hexCell)))
  try {
    return JSON.parse(execFileSync(PROVER, ['verify', path, file, proofFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim())
  } catch (e) {
    const out = String((e as { stdout?: string }).stdout ?? '')
    return { verified: false, error: out.trim() || 'refused' }
  }
}

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}`
/** The owner's signer: the key from a 32-byte seed signs m. Only this call holds the seed. */
export function sign(seed: Uint8Array, m: Uint8Array): Signed {
  const out = JSON.parse(execFileSync(PROVER, ['sphincs', hex(seed), hex(m)], { encoding: 'utf8' }).trim())
  return { publicKey: `0x${out.publicKey}`, signature: `0x${out.signature}`, message: hex(m) }
}
const keyCache = new Map<string, Uint8Array>()
/** A leanSPHINCS public key, its root then its public parameter, from a 32-byte seed. */
export function sphincsKey(seed: Uint8Array): Uint8Array {
  const k = hex(seed)
  if (!keyCache.has(k)) keyCache.set(k, Buffer.from(sign(seed, new Uint8Array(32)).publicKey.slice(2), 'hex'))
  return keyCache.get(k)!
}
/** A 32-byte value from a public label, so a record holds no secret worth keeping. */
export const fromLabel = (label: string) => keccak_256(new TextEncoder().encode(`exp-e2e-frames/32/${label}`))

/** A rule over up to three key seeds; absent keys are zero. */
export type Rule = { rule: bigint; seeds: (Uint8Array | undefined)[] }
export const keysOf = (r: Rule) => [0, 1, 2].map((i) => (r.seeds[i] ? sphincsKey(r.seeds[i]!) : new Uint8Array(32)))
export const digestOf = (r: Rule) => ruleDigest(r.rule, keysOf(r))
/** The signatures a rule gives on m: key 0 for rule 1; keys 0 and 1 for rule 2. */
export function signaturesOf(r: Rule, m: Uint8Array, by?: Uint8Array[]): { index: number; signed: Signed }[] {
  const idx = r.rule === 1n ? [0] : [0, 1]
  return idx.map((i, j) => ({ index: i, signed: sign(by?.[j] ?? r.seeds[i]!, m) }))
}

/** One identity's state: its secret, its version, and the parts of its current leaf. */
export type Identity = { s: Uint8Array; version: number; rule: Rule; rec: Uint8Array; salt: Uint8Array; recovery: Rule }
export const leafOfIdentity = (id: Identity) => leafOf(gCell(tables().gpow, id.version), id.s, digestOf(id.rule), id.rec, id.salt)

/** The bytes stream's two entries for a 128-bit integer: each limb's eight bytes as g^byte. */
function bytesOf(x: bigint): Cell[][] {
  const g = tables().gpow
  const limb = (l: bigint) => Array.from({ length: 8 }, (_, p): Cell => [BigInt(`0x${g[Number((l >> BigInt(8 * p)) & 0xffn)]}`), 0n])
  return [limb(x & ((1n << 64n) - 1n)), limb(x >> 64n)]
}
const bitCell = (b: number): Cell => [BigInt(b), 0n]
function pathStreams(p: Path) {
  return { path: p.kids.map(([l, r]) => [...cellsOf(l), ...cellsOf(r)]), bits: p.bits.map((b) => [bitCell(b)]) }
}

/** The witness for kappa's absence: the bracketing entry, its path, its gaps and the bytes. */
export function absence(ks: Keystore, n: Uint8Array, override?: { a: bigint; b: bigint; index: number; tree?: Keystore }) {
  const kappa = kappaOf(n)
  const e = override ?? ks.bracket(kappa)
  if (!e) return undefined
  const src = override?.tree ?? ks
  const d1 = kappa - e.a - 1n
  const d2 = e.b - kappa - 1n
  const ok = d1 >= 0n && d2 >= 0n
  // A gap that is negative has no 128-bit reading; the attempt hints 0, which the program refuses.
  const g1 = ok ? d1 : 0n
  const g2 = ok ? d2 : 0n
  return {
    path: src.revoked.path(e.index),
    entry: [cellOfInt(e.a), cellOfInt(e.b)] as Cell[],
    gaps: [cellOfInt(g1 & ((1n << 128n) - 1n)), cellOfInt(g2 & ((1n << 128n) - 1n))] as Cell[],
    bytes: [...bytesOf(e.a), ...bytesOf(e.b), ...bytesOf(kappa), ...bytesOf(g1), ...bytesOf(g2)],
  }
}

function sigStreams(sigs: { index: number; signed: Signed }[]) {
  return { signer: sigs.map((s) => [[1n << BigInt(s.index), 0n] as Cell]), sphincs: sigs.map((s) => s.signed) }
}

/** A spend's input: account (s, r), message m, against the keystore `ks`. */
export function spendInput(ks: Keystore, id: Identity, r: Uint8Array, m: Uint8Array, opts: { sigs?: { index: number; signed: Signed }[]; leafKeys?: Rule; leafIndex?: number; absenceOverride?: Parameters<typeof absence>[2] } = {}) {
  const g = tables().gpow
  const gv = gCell(g, id.version)
  const rule = opts.leafKeys ?? id.rule
  const leaf = leafOf(gv, id.s, digestOf(rule), id.rec, id.salt)
  const index = opts.leafIndex ?? ks.leaves.find(leaf)
  const tpath = ks.leaves.path(index < 0 ? 0 : index)
  const n = revTagOf(gv, id.s)
  const abs = absence(ks, n, opts.absenceOverride) ?? absence(ks, n, { ...ks.entries[0] })!
  const C = accountOf(id.s, r)
  const rho = ks.root()
  const D = H(H(C, m), rho)
  const sigs = opts.sigs ?? signaturesOf(id.rule, m)
  const ss = sigStreams(sigs)
  const tp = pathStreams(tpath)
  const np = pathStreams(abs.path)
  const input: Input = {
    public: cellsOf(D),
    witness: {
      w: [cellsOf(id.s), cellsOf(r), cellsOf(m), cellsOf(id.rec), cellsOf(id.salt)],
      version: [[gv]],
      rule: [[[rule.rule, 0n]]],
      keys: [keysOf(rule).flatMap((k) => cellsOf(k))],
      signer: ss.signer,
      path: [...tp.path, ...np.path],
      bits: [...tp.bits, ...np.bits],
      entry: [abs.entry],
      gaps: [abs.gaps],
      bytes: abs.bytes,
    },
    sphincs: ss.sphincs,
  }
  return { input, C, D, rho, leaf, n, leafIndex: index }
}

/** A registration's input. */
export function registerInput(id: Identity, opts: { regSecret?: Uint8Array } = {}) {
  const g = tables().gpow
  const leaf = leafOf(gCell(g, 0), id.s, digestOf(id.rule), id.rec, id.salt)
  const q = regTagOf(opts.regSecret ?? id.s)
  const D = H(leaf, q)
  const input: Input = {
    public: cellsOf(D),
    witness: { w: [cellsOf(id.s), cellsOf(id.rec), cellsOf(id.salt)], rule: [[[id.rule.rule, 0n]]], keys: [keysOf(id.rule).flatMap((k) => cellsOf(k))] },
    sphincs: [],
  }
  return { input, leaf, q, D }
}

export const MODE = { rotate: 0, recover: 1, cancel: 2 } as const
/** A rotation's input: the identity's current version signs (or its recovery rule, or it cancels) the next leaf. */
export function rotateInput(ks: Keystore, id: Identity, next: { rule: Rule; rec: Uint8Array; salt: Uint8Array }, mode: number, opts: { sigs?: { index: number; signed: Signed }[] } = {}) {
  const g = tables().gpow
  const gv = gCell(g, id.version)
  const leaf = leafOf(gv, id.s, digestOf(id.rule), id.rec, id.salt)
  const index = ks.leaves.find(leaf)
  const tpath = ks.leaves.path(index < 0 ? 0 : index)
  const n = revTagOf(gv, id.s)
  const abs = absence(ks, n) ?? absence(ks, n, { ...ks.entries[0] })!
  const rdn = digestOf(next.rule)
  const nextLeaf = leafOf(gCell(g, id.version + 1), id.s, rdn, next.rec, next.salt)
  const modeCell: Cell = [1n << BigInt(mode), 0n]
  const mrot = rotMessage(modeCell, nextLeaf)
  const signer = mode === MODE.recover ? id.recovery : id.rule
  const sigs = opts.sigs ?? signaturesOf(signer, mrot)
  const ss = sigStreams(sigs)
  const rho = ks.root()
  const D = H(H(rho, n), H(nextLeaf, pair(modeCell, [0n, 0n])))
  const tp = pathStreams(tpath)
  const np = pathStreams(abs.path)
  const witness: Input['witness'] = {
    w: [cellsOf(id.s), cellsOf(id.rec), cellsOf(id.salt), cellsOf(rdn), cellsOf(next.rec), cellsOf(next.salt)],
    version: [[gv]],
    mode: [[modeCell]],
    rule: [[[id.rule.rule, 0n]]],
    keys: [keysOf(id.rule).flatMap((k) => cellsOf(k))],
    signer: ss.signer,
    path: [...tp.path, ...np.path],
    bits: [...tp.bits, ...np.bits],
    entry: [abs.entry],
    gaps: [abs.gaps],
    bytes: abs.bytes,
  }
  if (mode === MODE.recover) {
    witness.rrule = [[[id.recovery.rule, 0n]]]
    witness.rkeys = [keysOf(id.recovery).flatMap((k) => cellsOf(k))]
  }
  return { input: { public: cellsOf(D), witness, sphincs: ss.sphincs } as Input, D, rho, n, nextLeaf, mrot }
}

/** The Keccak calls each statement makes outside the leanSPHINCS verifier, counted from lib.py. */
export const HASHES_OUTSIDE_VERIFIER = { spend: 55, rotate: 58, recover: 61, register: 9 }
