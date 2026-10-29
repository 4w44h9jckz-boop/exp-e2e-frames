// After a run: every mined frame transaction the registries sent, fetched from the chain and kept as
// raw bytes, so test/x10.test.ts checks them offline after the test network relaunches.
//
// usage: npx tsx experiments/15-x10-out-and-back/fixtures.ts <n>-<label>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Hex } from 'viem'
import { type FrameTxJson, frameTxFromJson, frameTxHash, getFrameTxJson, makeClient, serializeFrameTx } from '../../src/exp-frames/frametx/index.js'

const here = new URL('.', import.meta.url).pathname
const runLabel = process.argv[2]
if (!runLabel) throw new Error('usage: fixtures.ts <n>-<label>')
const record = JSON.parse(readFileSync(join(here, 'results', `${runLabel}.json`), 'utf8')) as { steps: { step: string; hash?: Hex }[]; contracts: Record<string, string> }
const client = makeClient()
const out = []
for (const s of record.steps) {
  if (!s.hash) continue
  const json = (await getFrameTxJson(client, s.hash)) as FrameTxJson | null
  if (!json) throw new Error(`${s.step}: ${s.hash} not found`)
  const tx = frameTxFromJson(json)
  if (frameTxHash(tx).toLowerCase() !== s.hash.toLowerCase()) throw new Error(`${s.step}: rebuilt hash differs`)
  out.push({ step: s.step, hash: s.hash, raw: serializeFrameTx(tx) })
}
const dir = new URL('../../test/fixtures/x10/', import.meta.url).pathname
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, `${runLabel}.json`), `${JSON.stringify({ run: runLabel, contracts: record.contracts, transactions: out }, null, 1)}\n`)
console.log(`${out.length} transactions kept in test/fixtures/x10/${runLabel}.json`)
