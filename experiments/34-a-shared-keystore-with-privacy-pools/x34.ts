// Experiment 34: the host side. The leanVM programs of arm A, assembled from experiment 32's library
// and this experiment's lib4.py; their witnesses; the pool's trees, compiled contracts and Groth16
// withdrawals.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { keccak_256 } from '@noble/hashes/sha3'
import { type Abi, type Hex, bytesToHex, encodeAbiParameters, keccak256 } from 'viem'
import {
  type Cell, type Keystore, H, accountOf, cellsOf, gCell, leafOf, pair, regTagOf, revTagOf,
} from '../32-a-shared-keystore-for-stealth-accounts-in-leanvm/keystore.js'
import {
  type Input, type Rule, type Signed, absence, digestOf, keysOf, liftedFromV2a, sign, sphincsKey, tables,
} from '../32-a-shared-keystore-for-stealth-accounts-in-leanvm/x32.js'

const here = new URL('.', import.meta.url).pathname
const X32 = join(here, '../32-a-shared-keystore-for-stealth-accounts-in-leanvm')
export const BUILD = join(here, 'build')
const root = join(here, '../..')
export const WORK = join(root, 'work')

// ---- the programs ----

export type Program4 = 'register4' | 'scoped' | 'scoped_open'
const lit = (c: [string, string, string]) => `f192(${c[0]},${c[1]},${c[2]})`
const split = (src: string) => { const i = src.search(/^(@inline|def )/m); return [src.slice(0, i), src.slice(i)] }

/** Assemble one program: both libraries' constants, the lifted verifier, both libraries' functions, the entry. */
export function assemble(name: Program4) {
  const t = tables()
  const lifted = liftedFromV2a()
  const [c32, f32] = split(readFileSync(join(X32, 'programs/lib.py'), 'utf8').replace('HPOW_PLACEHOLDER', `[${t.hpow.map(lit).join(', ')}]`))
  const [c4, f4] = split(readFileSync(join(here, 'programs/lib4.py'), 'utf8'))
  const entry = readFileSync(join(here, `programs/${name}.py`), 'utf8')
  const head = entry.split('\n').filter((l) => l.startsWith('#')).join('\n')
  const body = entry.split('\n').filter((l) => !l.startsWith('#')).join('\n')
  const file = `${head}\n#\n# Assembled by experiment 34's x34.ts: experiment 32's programs/lib.py and this experiment's\n# programs/lib4.py, with experiment 19's lifted leanSPHINCS verifier and verify_one, and this entry point.\nfrom snark_lib import *\n\n${c32}\n${c4}\n${lifted}\n${f32}\n${f4}\n${body}`
  if (!existsSync(BUILD)) mkdirSync(BUILD)
  const path = join(BUILD, `${name}.py`)
  writeFileSync(path, file)
  return { path, key: `0x${Buffer.from(keccak_256(Buffer.from(file))).toString('hex')}` as Hex, bytes: Buffer.byteLength(file) }
}

// ---- the leaf with two rules ----

export const TAU_SCOPE = 1263730952n
export const TAU_LIST = 1263730953n
const tagged = (tau: bigint) => pair([tau, 0n], [0n, 0n])
export const scopeDigest = (kscope: Uint8Array, lam: Uint8Array) => H(H(tagged(TAU_SCOPE), kscope), lam)
export const listMessage = (lam: Uint8Array) => H(tagged(TAU_LIST), lam)

/** A depth-4 Keccak list of 32-byte entries, zero-padded to 16. */
export function listOf(entries: Uint8Array[]) {
  if (entries.length > 16) throw new Error('at most 16 entries')
  const level0 = Array.from({ length: 16 }, (_, i) => entries[i] ?? new Uint8Array(32))
  const levels = [level0]
  for (let l = 0; l < 4; l++) levels.push(Array.from({ length: levels[l].length / 2 }, (_, j) => H(levels[l][2 * j], levels[l][2 * j + 1])))
  const path = (i: number) => {
    const kids: [Uint8Array, Uint8Array][] = []
    const bits: number[] = []
    for (let l = 0; l < 4; l++) { const left = i & ~1; kids.push([levels[l][left], levels[l][left + 1]]); bits.push(i & 1); i >>= 1 }
    return { kids, bits }
  }
  return { root: levels[4][0], path }
}

/** An identity with a main rule and a scoped key bound to a list. */
export type Identity4 = { s: Uint8Array; version: number; main: Rule; scopeSeed: Uint8Array; list: Uint8Array[]; rec: Uint8Array; salt: Uint8Array }
export const rmainOf = (id: Identity4) => digestOf(id.main)
export const lambdaOf = (id: Identity4) => listOf(id.list).root
export const ruleDigest4 = (id: Identity4) => H(rmainOf(id), scopeDigest(sphincsKey(id.scopeSeed), lambdaOf(id)))
export const leafOf4 = (id: Identity4) => leafOf(gCell(tables().gpow, id.version), id.s, ruleDigest4(id), id.rec, id.salt)

const sigStreams = (sigs: { index: number; signed: Signed }[]) => ({ signer: sigs.map((s) => [[1n << BigInt(s.index), 0n] as Cell]), sphincs: sigs.map((s) => s.signed) })
function mainSigs(r: Rule, m: Uint8Array) {
  const idx = r.rule === 1n ? [0] : [0, 1]
  return idx.map((i) => ({ index: i, signed: sign(r.seeds[i]!, m) }))
}
const pathStreams = (p: { kids: [Uint8Array, Uint8Array][]; bits: number[] }) => ({ path: p.kids.map(([l, r]) => [...cellsOf(l), ...cellsOf(r)]), bits: p.bits.map((b) => [[BigInt(b), 0n] as Cell]) })

/** register4's input: the leaf at version 0 with two rules, Q, and the main rule's signature on the list. */
export function register4Input(id: Identity4) {
  const lam = lambdaOf(id)
  const leaf = leafOf4({ ...id, version: 0 })
  const q = regTagOf(id.s)
  const D = H(leaf, q)
  const sigs = mainSigs(id.main, listMessage(lam))
  const ss = sigStreams(sigs)
  const input: Input = {
    public: cellsOf(D),
    witness: {
      w: [cellsOf(id.s), cellsOf(id.rec), cellsOf(id.salt), cellsOf(sphincsKey(id.scopeSeed)), cellsOf(lam)],
      rule: [[[id.main.rule, 0n]]],
      keys: [keysOf(id.main).flatMap((k) => cellsOf(k))],
      signer: ss.signer,
    },
    sphincs: ss.sphincs,
  }
  return { input, leaf, q, D }
}

/**
 * scoped's input for the account (s, r): the scoped key signs m, and pc is the precommitment, a
 * 32-byte word. `listIndex` is pc's place in the list; a pc outside the list takes index 0's path,
 * which the program refuses.
 */
export function scopedInput(ks: Keystore, id: Identity4, r: Uint8Array, m: Uint8Array, pc: Uint8Array, o: { scopeSignerSeed?: Uint8Array } = {}) {
  const g = tables().gpow
  const gv = gCell(g, id.version)
  const leaf = leafOf4(id)
  const index = ks.leaves.find(leaf)
  const tpath = ks.leaves.path(index < 0 ? 0 : index)
  const n = revTagOf(gv, id.s)
  const abs = absence(ks, n) ?? absence(ks, n, { ...ks.entries[0] })!
  const lam = lambdaOf(id)
  const list = listOf(id.list)
  const li = id.list.findIndex((e) => Buffer.compare(Buffer.from(e), Buffer.from(pc)) === 0)
  const lp = list.path(li < 0 ? 0 : li)
  const C = accountOf(id.s, r)
  const rho = ks.root()
  const D = H(H(C, m), H(rho, pc))
  const signed = sign(o.scopeSignerSeed ?? id.scopeSeed, m)
  const tp = pathStreams(tpath)
  const np = pathStreams(abs.path)
  const lps = pathStreams(lp)
  const input: Input = {
    public: cellsOf(D),
    witness: {
      w: [cellsOf(id.s), cellsOf(r), cellsOf(m), cellsOf(id.rec), cellsOf(id.salt), cellsOf(rmainOf(id)), cellsOf(lam), cellsOf(pc)],
      version: [[gv]],
      keys: [[...cellsOf(sphincsKey(id.scopeSeed)), [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n]]],
      path: [...tp.path, ...np.path],
      bits: [...tp.bits, ...np.bits],
      entry: [abs.entry],
      gaps: [abs.gaps],
      bytes: abs.bytes,
      lpath: lps.path,
      lbits: lps.bits,
    },
    sphincs: [signed],
  }
  return { input, C, D, rho, leaf, inList: li >= 0 }
}

// ---- Poseidon over BN254 and the pool's LeanIMT ----

export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
type PoseidonFn = ((xs: bigint[]) => bigint)
let poseidonCache: PoseidonFn | undefined
export async function poseidon(): Promise<PoseidonFn> {
  if (poseidonCache) return poseidonCache
  // circomlibjs has no types; its Poseidon is circomlib's, the hash the pool's circuits use.
  const { buildPoseidon } = (await import('circomlibjs')) as unknown as { buildPoseidon: () => Promise<{ (xs: bigint[]): Uint8Array; F: { toObject: (x: Uint8Array) => bigint } }> }
  const p = await buildPoseidon()
  poseidonCache = (xs: bigint[]) => p.F.toObject(p(xs))
  return poseidonCache
}

/** zk-kit's LeanIMT: a node with no right sibling moves up unchanged. */
export class LeanIMT {
  levels: bigint[][] = [[]]
  constructor(private h: PoseidonFn) {}
  get size() { return this.levels[0].length }
  get depth() { return this.levels.length - 1 }
  insert(leaf: bigint) {
    this.levels[0].push(leaf)
    let l = 0
    while (this.levels[l].length > 1) {
      if (!this.levels[l + 1]) this.levels.push([])
      const up: bigint[] = []
      const lv = this.levels[l]
      for (let j = 0; j < lv.length; j += 2) up.push(j + 1 < lv.length ? this.h([lv[j], lv[j + 1]]) : lv[j])
      this.levels[l + 1] = up
      l++
    }
    this.levels.length = l + 1
  }
  root() { return this.levels[this.depth][0] }
  /** The circuit's form: siblings padded with zeros to 32, the index, the depth. */
  proof(index: number) {
    const siblings: bigint[] = []
    let i = index
    for (let l = 0; l < this.depth; l++) {
      const lv = this.levels[l]
      const sib = i & 1 ? lv[i - 1] : (i + 1 < lv.length ? lv[i + 1] : 0n)
      siblings.push(sib)
      i >>= 1
    }
    while (siblings.length < 32) siblings.push(0n)
    return { siblings, index, depth: this.depth, root: this.root() }
  }
  indexOf(leaf: bigint) { return this.levels[0].indexOf(leaf) }
}

// ---- the pool's contracts ----

const PP = join(WORK, 'privacy-pools-core/packages/contracts/src')
const DEPS = join(WORK, 'pp-deps/node_modules')
const CIRC = join(WORK, 'x34-circuits')
type Compiled = { abi: Abi; bytecode: string; linkReferences: Record<string, Record<string, { start: number; length: number }[]>>; deployed: string; immutables: Record<string, { start: number; length: number }[]> }

/** Compile the pool with solc 0.8.28 and the repository's remappings, its verifiers from this experiment's setup. */
export function compilePool(circuits = CIRC): Record<string, Compiled> {
  const solc = createRequire(import.meta.url)(join(DEPS, 'solc'))
  const remap: [string, string][] = [
    ['@oz/', join(DEPS, '@openzeppelin/contracts/')],
    ['@oz-upgradeable/', join(DEPS, '@openzeppelin/contracts-upgradeable/')],
    ['@openzeppelin/contracts/', join(DEPS, '@openzeppelin/contracts/')],
    ['lean-imt/', join(DEPS, '@zk-kit/lean-imt.sol/')],
    ['poseidon/', join(DEPS, 'poseidon-solidity/')],
    ['poseidon-solidity/', join(DEPS, 'poseidon-solidity/')],
    ['contracts/', join(PP, 'contracts/')],
    ['interfaces/', join(PP, 'interfaces/')],
  ]
  const resolve = (p: string) => { for (const [a, b] of remap) if (p.startsWith(a)) return b + p.slice(a.length); return p }
  const verifier = (file: string, name: string) => readFileSync(join(circuits, file), 'utf8').replace('contract Groth16Verifier', `contract ${name}`)
  const sources: Record<string, { content: string }> = {
    'contracts/Entrypoint.sol': { content: readFileSync(join(PP, 'contracts/Entrypoint.sol'), 'utf8') },
    'contracts/implementations/PrivacyPoolSimple.sol': { content: readFileSync(join(PP, 'contracts/implementations/PrivacyPoolSimple.sol'), 'utf8') },
    '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol': { content: readFileSync(join(DEPS, '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol'), 'utf8') },
    'poseidon-solidity/PoseidonT3.sol': { content: readFileSync(join(DEPS, 'poseidon-solidity/PoseidonT3.sol'), 'utf8') },
    'poseidon-solidity/PoseidonT4.sol': { content: readFileSync(join(DEPS, 'poseidon-solidity/PoseidonT4.sol'), 'utf8') },
    'x34/WithdrawalVerifier.sol': { content: verifier('withdraw_verifier.sol', 'WithdrawalVerifier') },
    'x34/CommitmentVerifier.sol': { content: verifier('commitment_verifier.sol', 'CommitmentVerifier') },
  }
  const input = { language: 'Solidity', sources, settings: { optimizer: { enabled: true, runs: 10_000 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.bytecode.linkReferences', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } } } }
  const findImports = (p: string) => { const f = resolve(p); return existsSync(f) ? { contents: readFileSync(f, 'utf8') } : { error: `not found: ${p}` } }
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }))
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === 'error')
  if (errors.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join('\n'))
  const pick = (file: string, name: string): Compiled => {
    const c = out.contracts[file][name]
    return { abi: c.abi, bytecode: c.evm.bytecode.object, linkReferences: c.evm.bytecode.linkReferences ?? {}, deployed: c.evm.deployedBytecode.object, immutables: c.evm.deployedBytecode.immutableReferences ?? {} }
  }
  return {
    Entrypoint: pick('contracts/Entrypoint.sol', 'Entrypoint'),
    PrivacyPoolSimple: pick('contracts/implementations/PrivacyPoolSimple.sol', 'PrivacyPoolSimple'),
    ERC1967Proxy: pick('@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol', 'ERC1967Proxy'),
    PoseidonT3: pick('poseidon-solidity/PoseidonT3.sol', 'PoseidonT3'),
    PoseidonT4: pick('poseidon-solidity/PoseidonT4.sol', 'PoseidonT4'),
    WithdrawalVerifier: pick('x34/WithdrawalVerifier.sol', 'WithdrawalVerifier'),
    CommitmentVerifier: pick('x34/CommitmentVerifier.sol', 'CommitmentVerifier'),
  }
}

/** Fill a compiled bytecode's library placeholders. */
export function link(c: Compiled, libs: Record<string, Hex>): Hex {
  let code = c.bytecode
  for (const refs of Object.values(c.linkReferences)) {
    for (const [name, spots] of Object.entries(refs)) {
      const addr = libs[name]
      if (!addr) throw new Error(`no address for library ${name}`)
      for (const s of spots) code = code.slice(0, 2 * s.start) + addr.slice(2).toLowerCase() + code.slice(2 * (s.start + s.length))
    }
  }
  return `0x${code}`
}

/**
 * A contract's runtime code for a genesis allocation at `address`, as a CREATE there would leave it:
 * a library's leading PUSH20 holds its own address, and every immutable holds `immutable(address)`.
 * Used for the code EIP-8037's state gas makes too large to deploy in one transaction here.
 */
export function genesisCode(c: Compiled, address: Hex, immutable: (start: number) => Hex = () => pad32(address)): Hex {
  let code = c.deployed
  if (code.startsWith('73' + '00'.repeat(20))) code = `73${address.slice(2).toLowerCase()}${code.slice(42)}`
  for (const spots of Object.values(c.immutables)) for (const sp of spots) code = code.slice(0, 2 * sp.start) + immutable(sp.start).slice(2) + code.slice(2 * (sp.start + sp.length))
  return `0x${code}`
}
const pad32 = (a: Hex): Hex => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`

/** A withdrawal's context, as the pool checks it: keccak256(abi.encode(withdrawal, scope)) mod P. */
export const contextOf = (processooor: Hex, data: Hex, scope: bigint) =>
  BigInt(keccak256(encodeAbiParameters([{ type: 'tuple', components: [{ type: 'address' }, { type: 'bytes' }] }, { type: 'uint256' }], [[processooor, data], scope]))) % P

/** A Groth16 proof with snarkjs, and its calldata form. */
export async function groth16(circuit: 'withdraw' | 'commitment', input: Record<string, unknown>, circuits = CIRC) {
  // snarkjs has no types.
  const snarkjs = (await import('snarkjs')) as unknown as { groth16: { fullProve: (i: unknown, w: string, z: string) => Promise<{ proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }; publicSignals: string[] }>; verify: (vk: unknown, p: string[], pr: unknown) => Promise<boolean> } }
  const t = Date.now()
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, join(circuits, `${circuit}_main_js/${circuit}_main.wasm`), join(circuits, `${circuit}.zkey`))
  const ms = Date.now() - t
  const ok = await snarkjs.groth16.verify(JSON.parse(readFileSync(join(circuits, `${circuit}.vkey.json`), 'utf8')), publicSignals, proof)
  const b = (x: string) => BigInt(x)
  return {
    ms, ok, publicSignals: publicSignals.map(b),
    sol: { pA: [b(proof.pi_a[0]), b(proof.pi_a[1])], pB: [[b(proof.pi_b[0][1]), b(proof.pi_b[0][0])], [b(proof.pi_b[1][1]), b(proof.pi_b[1][0])]], pC: [b(proof.pi_c[0]), b(proof.pi_c[1])], pubSignals: publicSignals.map(b) },
  }
}

/** A word's 32 bytes, big-endian, as the account and the programs hash it. */
export const word32 = (x: bigint) => Buffer.from(x.toString(16).padStart(64, '0'), 'hex')
export const hx = (b: Uint8Array): Hex => bytesToHex(b)
