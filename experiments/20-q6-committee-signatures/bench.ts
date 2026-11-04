// Experiment 20 (Q6), arm 5, the cold half: experiment 19's prover, as the local node runs it once
// per block (a fresh process, its first aggregation), on n real committee signatures, each a
// distinct member key on one message. Three passes at each size.
// usage: npx tsx experiments/20-q6-committee-signatures/bench.ts <label>
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { keccak256, toHex } from 'viem'
import { loadKey, run } from '../../src/e2e/index.js'
import * as Q from './q6.js'

const [label] = process.argv.slice(2)
if (!label) throw new Error('usage: bench.ts <label>')
const { privateKey } = loadKey()
const here = new URL('.', import.meta.url).pathname
const m = keccak256(toHex(`exp-e2e-frames/20/bench/${label}`))
const signed = Array.from({ length: 64 }, (_, i) => Q.L.sign(Q.seedOf(privateKey, `bench/${i}`), Buffer.from(m.slice(2), 'hex')))
const rows = []
for (const n of [3, 4, 16, 64]) {
  for (let pass = 0; pass < 3; pass++) {
    const t = Date.now()
    const a = Q.aggregate(signed.slice(0, n))
    rows.push({ n, pass, wallMs: Date.now() - t, ...a })
    console.log(`n ${n} pass ${pass}: aggregate ${a.aggregateMs.toFixed(0)} ms, proof ${a.proofBytes} bytes, verify ${a.verifyMs} ms, verified ${a.verified}`)
  }
}
const record = { experiment: 20, arm: 5, label, repoCommit: (await run('git', ['rev-parse', 'HEAD'], { cwd: join(here, '../..') })).trim(), prover: 'experiments/19-x14-hash-based-stealth-addresses-under-8288/prover, leanVM 3cbac04, target-cpu=native', signMs: signed.map((s) => s.signMs), rows }
writeFileSync(join(here, 'results', `${label}-bench.json`), `${JSON.stringify(record, null, 2)}\n`)
