// Experiment 21 (Q7), plan step 3: one device proves X6's withdrawal statement alone, with leanVM.
// Experiment 19's v5_tornado.py (Tornado's statement in a Keccak tree), its prover built here with
// target-cpu=native: three measured passes after a warm-up, then `x14-prover verify` on the proof
// against its digest D and the program's key, as docs/leanvm-program-layout.md fixes them.
// The notes are random and not recorded. usage: npx tsx experiments/21-q7-collaborative-hash-proof/baseline.ts <label>
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bytesToHex, keccak256 } from 'viem'
import { run } from '../../src/e2e/index.js'
import * as L from '../19-x14-hash-based-stealth-addresses-under-8288/lean.js'

const [label] = process.argv.slice(2)
if (!label) throw new Error('usage: baseline.ts <label>')
const here = new URL('.', import.meta.url).pathname
const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n))
const notes = [0, 1].map(() => ({ ns: rnd(32), s: rnd(32) }))
const leaves = notes.map((n) => L.leafOf(n.ns, n.s))
const binding = rnd(32)
const w = L.v5(notes[0].ns, notes[0].s, binding, L.treeOf(leaves), 0)
const dir = mkdtempSync(join(tmpdir(), 'q7-'))
const proofOut = join(dir, 'proof.bin')
const proved = L.prove('v5_tornado', { ...w.input, proofOut }, 3)
const publicFile = join(dir, 'public.json')
const hexCell = ([a, b]: [bigint, bigint]) => [a.toString(16), b.toString(16)]
writeFileSync(publicFile, JSON.stringify(L.cellsOf(w.D).map(hexCell)))
const verified = JSON.parse(execFileSync(L.PROVER, ['verify', L.PROGRAM('v5_tornado'), publicFile, proofOut], { encoding: 'utf8' }).trim().split('\n').pop()!)
const record = {
  experiment: 21, step: 3, label, repoCommit: (await run('git', ['rev-parse', 'HEAD'], { cwd: join(here, '../..') })).trim(),
  prover: 'experiments/19-x14-hash-based-stealth-addresses-under-8288/prover, leanVM 3cbac04, target-cpu=native',
  machine: execFileSync('sh', ['-c', "grep -m1 'model name' /proc/cpuinfo | cut -d: -f2; nproc"], { encoding: 'utf8' }).trim().split('\n').map((s) => s.trim()),
  program: 'v5_tornado.py', programKey: keccak256(readFileSync(L.PROGRAM('v5_tornado'))), D: bytesToHex(w.D),
  proved: { cycles: proved.cycles, proveMs: proved.proveMs, warmupMs: proved.warmupMs, proofBytes: proved.proofBytes, proofFileBytes: statSync(proofOut).size, verifyMs: proved.verifyMs, verified: proved.verified, peakRssBytes: proved.peakRssBytes },
  verifyCommand: verified,
}
writeFileSync(join(here, 'results', `${label}-baseline.json`), `${JSON.stringify(record, null, 2)}\n`)
console.log(JSON.stringify(record.proved), JSON.stringify(verified))
