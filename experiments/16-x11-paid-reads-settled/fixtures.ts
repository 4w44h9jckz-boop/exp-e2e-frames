// After a run: every mined frame transaction the pool sent, fetched from the chain and kept as raw
// bytes, with the members, the issuers' key and the tickets, so test/x11.test.ts checks them
// offline after the test network relaunches.
//
// usage: npx tsx experiments/16-x11-paid-reads-settled/fixtures.ts <n>-<label>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Address, Hex } from 'viem'
import { type FrameTxJson, frameTxFromJson, frameTxHash, getFrameTxJson, makeClient, serializeFrameTx } from '../../src/exp-frames/frametx/index.js'

const here = new URL('.', import.meta.url).pathname
const runLabel = process.argv[2]
if (!runLabel) throw new Error('usage: fixtures.ts <n>-<label>')
type Record = {
  pool: Address
  members: Address[]
  chainId: number
  issuance: { key: Hex }
  servers: { [name: string]: Address }
  tickets: { server: string; serial: Hex; ticket: Hex }[]
  steps: { step: string; outcome: string; hash?: Hex }[]
}
const record = JSON.parse(readFileSync(join(here, 'results', `${runLabel}.json`), 'utf8')) as Record
const client = makeClient()
const transactions = []
for (const s of record.steps) {
  // A refused step carries the hash it would have had; it was never mined.
  if (!s.hash || s.outcome === 'refused') continue
  const json = (await getFrameTxJson(client, s.hash)) as FrameTxJson | null
  if (!json) throw new Error(`${s.step}: ${s.hash} not found`)
  const tx = frameTxFromJson(json)
  if (frameTxHash(tx).toLowerCase() !== s.hash.toLowerCase()) throw new Error(`${s.step}: rebuilt hash differs`)
  transactions.push({ step: s.step, hash: s.hash, raw: serializeFrameTx(tx) })
}
const tickets = record.tickets.map((t) => ({ server: record.servers[t.server], serial: t.serial, ticket: t.ticket }))
const dir = new URL('../../test/fixtures/x11/', import.meta.url).pathname
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, `${runLabel}.json`), `${JSON.stringify({ run: runLabel, pool: record.pool, members: record.members, chainId: record.chainId, key: record.issuance.key, tickets, transactions }, null, 1)}\n`)
console.log(`${transactions.length} transactions and ${tickets.length} tickets kept in test/fixtures/x11/${runLabel}.json`)
