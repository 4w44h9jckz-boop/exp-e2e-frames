// Experiment 22 (Q1), arm 1: every transaction in experiments 01 to 18's run records, sorted by how
// it is authorized (README, "Step 1: the inventory").
//
// A run record has no common format, so every 32-byte hex string in it is a candidate, and the test
// network says which are transactions: eth_getTransactionByHash returns one or nothing. The network
// has not relaunched since these runs, so their hashes still resolve; a hash that returns nothing
// is another 32-byte value, or a transaction that was refused and never mined.
//
// Shapes:
//   (a) a type-2 (or earlier) transaction from an EOA;
//   (b) a frame transaction with a secp256k1 or P-256 signature in the protocol's signature list;
//   (c) a frame transaction whose VERIFY target's code calls ecrecover (0x01) or P256VERIFY (0x100);
//   (d) a frame transaction with neither: a proof, a ticket or a committee's signature checked in
//       VERIFY. BLS checks (EIP-2537, 0x0b to 0x11) are counted under (d), since they are
//       committee and ticket signatures, which other experiments of the track move.
// The network serves no tracer, so (c) against (d) is read from the code: a STATICCALL whose
// address argument, the second stack item, is pushed as 0x01 or 0x0100. That is a heuristic
// and the record says so; every (c) and (d) entry lists its targets for a reader to check.
//
// usage: npx tsx experiments/22-q1-leansphincs-senders/inventory.ts <n>-<label>
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const here = new URL('.', import.meta.url).pathname
const root = join(here, '..')
const label = process.argv[2]
if (!label) throw new Error('usage: inventory.ts <n>-<label>')
const RPC = 'https://rpc1.privacy.ethrex.xyz'
const PROTOCOL = new Set(['0x0000000000000000000000000000000000008141', '0x0000000000000000000000000000000000008272', '0x0000000000000000000000000000000000008250'])

let id = 0
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
      const j = (await r.json()) as { result?: T; error?: { message: string } }
      if (j.error) throw new Error(j.error.message)
      return j.result as T
    } catch (e) {
      if (attempt >= 3) throw e
      await new Promise((ok) => setTimeout(ok, 500 * 2 ** attempt))
    }
  }
}

type Frame = { mode: string; to: string | null; data: string; flags: string }
type Sig = { scheme: string; signer: string | null }
type Tx = { hash: string; type: string; from: string; to?: string | null; blockNumber: string; frames?: Frame[]; signatures?: Sig[]; sender?: string }

// Opcodes with immediates, so the scan walks instructions rather than bytes.
function precompileCalls(code: string): Set<number> {
  const b = Buffer.from(code.replace(/^0x/, ''), 'hex')
  const ops: { op: number; imm: bigint | null }[] = []
  for (let i = 0; i < b.length; i++) {
    const op = b[i]
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f
      ops.push({ op, imm: BigInt('0x' + (b.subarray(i + 1, i + 1 + n).toString('hex') || '0')) })
      i += n
    } else if (op === 0x5f) ops.push({ op, imm: 0n })
    else ops.push({ op, imm: null })
  }
  // STATICCALL takes gas from the top of the stack and the address from the item below it. A
  // contract that calls a precompile by a constant pushes the address, then the gas (GAS or a
  // PUSH), then calls. Only that address is read, so a 256 used as an offset is not counted.
  const found = new Set<number>()
  ops.forEach((o, i) => {
    if (o.op !== 0xfa || i < 2) return // STATICCALL
    const gasOp = ops[i - 1]
    if (!(gasOp.op === 0x5a || gasOp.imm !== null)) return
    const v = ops[i - 2].imm
    if (v === null) return
    if (v === 0x01n || v === 0x100n || (v >= 0x0bn && v <= 0x11n)) found.add(Number(v))
  })
  return found
}

const codeCache = new Map<string, Set<number>>()
async function calls(addr: string): Promise<Set<number>> {
  if (!codeCache.has(addr)) codeCache.set(addr, precompileCalls(await rpc<string>('eth_getCode', [addr, 'latest'])))
  return codeCache.get(addr)!
}

// Resolved by hand, after reading each experiment's README: a key check that is a committee's,
// not the account's own, is shape (d). Each override names its reason and is recorded.
const RESOLVE: Record<string, { shape: string; why: string }> = {
  '0xca06d48cb5764314a0189e11e65ca74014eb1898': { shape: 'd', why: "experiment 16's pool: three of its four attesters' ECDSA signatures, a committee, checked in VERIFY" },
}

const experiments = readdirSync(root).filter((d) => /^(0[1-9]|1[0-8])-/.test(d)).sort()
const out: Record<string, unknown>[] = []
const summary: Record<string, Record<string, number>> = {}
for (const exp of experiments) {
  const dir = join(root, exp, 'results')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []
  const candidates = new Set<string>()
  for (const f of files) for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/"(0x[0-9a-fA-F]{64})"/g)) candidates.add(m[1].toLowerCase())
  const counts: Record<string, number> = { a: 0, b: 0, c: 0, d: 0, candidates: candidates.size, records: files.length }
  for (const h of [...candidates].sort()) {
    const tx = await rpc<Tx | null>('eth_getTransactionByHash', [h])
    if (!tx) continue
    let shape: string
    const entry: Record<string, unknown> = { experiment: exp, hash: tx.hash, block: Number(tx.blockNumber), type: tx.type, from: tx.from }
    if (tx.type !== '0x6') {
      shape = 'a'
      entry.to = tx.to ?? null
    } else {
      const sender = (tx.sender ?? tx.from).toLowerCase()
      const classical = (tx.signatures ?? []).filter((s) => s.scheme === '0x1' || s.scheme === '0x2')
      entry.signatures = (tx.signatures ?? []).map((s) => ({ scheme: Number(s.scheme), signer: s.signer ? s.signer.toLowerCase() : 'sender' }))
      const verifyTargets = [...new Set((tx.frames ?? []).filter((f) => f.mode === '0x1').map((f) => (f.to ? f.to.toLowerCase() : sender)).filter((a) => !PROTOCOL.has(a)))]
      const pre: Record<string, number[]> = {}
      for (const t of verifyTargets) pre[t] = [...(await calls(t))]
      entry.verifyTargets = pre
      entry.dependencyFrames = (tx.frames ?? []).filter((f) => f.mode === '0x4').length
      if (classical.length > 0) shape = 'b'
      else if (Object.values(pre).some((p) => p.includes(0x01) || p.includes(0x100))) shape = 'c'
      else shape = 'd'
      const resolved = verifyTargets.map((t) => RESOLVE[t]).find(Boolean)
      if (shape !== 'b' && resolved) {
        entry.heuristicShape = shape
        entry.resolvedBy = resolved.why
        shape = resolved.shape
      }
    }
    entry.shape = shape
    counts[shape]++
    out.push(entry)
  }
  summary[exp] = counts
  console.log(exp, JSON.stringify(counts))
}
const commit = execSync('git rev-parse HEAD', { cwd: here }).toString().trim()
writeFileSync(join(here, 'results', `${label}.json`), JSON.stringify({
  experiment: 22, arm: 1, run: label, date: new Date().toISOString(), repoCommit: commit, rpc: RPC,
  command: `npx tsx experiments/22-q1-leansphincs-senders/inventory.ts ${label}`,
  method: 'every 32-byte hex string in experiments 01 to 18\'s results/*.json, resolved with eth_getTransactionByHash; (c) against (d) from a static scan of each VERIFY target\'s code for a STATICCALL to 0x01 or 0x100, a heuristic, then the hand resolutions in RESOLVE',
  resolutions: RESOLVE,
  summary, transactions: out,
}, null, 2) + '\n')
console.log(`recorded results/${label}.json`)
