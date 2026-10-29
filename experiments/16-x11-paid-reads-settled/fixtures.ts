// After a run: every mined frame transaction the pool sent, fetched from the chain and kept as raw
// bytes, with the members, the issuers' key and the tickets, so test/x11.test.ts checks them
// offline after the test network relaunches.
//
// usage: npx tsx experiments/16-x11-paid-reads-settled/fixtures.ts <n>-<label>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Address, Hex } from 'viem'
import { type FrameTxJson, frameTxFromJson, frameTxHash, getFrameTxJson, makeClient, parseFrameTx, serializeFrameTx } from '../../src/exp-frames/frametx/index.js'

const here = new URL('.', import.meta.url).pathname
const runLabel = process.argv[2]
if (!runLabel) throw new Error('usage: fixtures.ts <n>-<label>')
type Record = {
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
// Every transaction kept here was sent by the pool, as its own sender. Run 1's record has no
// separate field for its address: the accounting object `pool` overwrote it (run.ts now keeps both).
const senders = [...new Set(transactions.map((t) => parseFrameTx(t.raw).sender.toLowerCase()))]
if (senders.length !== 1) throw new Error(`the transactions have ${senders.length} senders, not one`)
const pool = parseFrameTx(transactions[0].raw).sender
const tickets = record.tickets.map((t) => ({ server: record.servers[t.server], serial: t.serial, ticket: t.ticket }))
const dir = new URL('../../test/fixtures/x11/', import.meta.url).pathname
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, `${runLabel}.json`), `${JSON.stringify({ run: runLabel, pool, members: record.members, chainId: record.chainId, key: record.issuance.key, tickets, transactions }, null, 1)}\n`)
console.log(`${transactions.length} transactions and ${tickets.length} tickets kept in test/fixtures/x11/${runLabel}.json`)
