// The frame transaction vector set, and experiment 03's record of three implementations run
// against it, checked offline. The set must be internally sound: every raw transaction starts with
// the type byte and hashes to its hash. The record must be the set it claims: same files, same
// cases, and the disagreements it lists must be exactly the answers that differ from the expected
// values.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { keccak256 } from 'viem'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url).pathname
const dir = join(root, 'vectors/frame-tx')
const load = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'))
const sha = (f: string) => createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')

const txs = existsSync(join(dir, 'transactions.json')) ? load('transactions.json').cases : undefined

describe.runIf(txs !== undefined)('the frame transaction vector set', () => {
  it('hashes every raw transaction to its hash, and starts it with type 0x06', () => {
    for (const c of txs) {
      expect(c.raw.startsWith('0x06')).toBe(true)
      expect(keccak256(c.raw)).toBe(c.hash.toLowerCase())
    }
  })
  it('takes every mined hash from the chain, and says where every other value comes from', () => {
    for (const c of txs) {
      expect(['chain', 'texts']).toContain(c.hashSource)
      expect(['chain', 'texts']).toContain(c.sigHashSource)
      if (c.name.startsWith('mined')) expect(c.hashSource).toBe('chain')
      if (c.sigHashSource === 'chain') expect(c.sigHashConfirmedBy.length).toBeGreaterThan(0)
    }
  })
  it('gives every reject case a reason', () => {
    for (const c of load('reject.json').cases) expect(c.why.length).toBeGreaterThan(0)
  })
})

const resultsDir = join(root, 'experiments/03-i2-one-frame-format/results')
const records = existsSync(resultsDir)
  ? readdirSync(resultsDir).filter((f) => f.endsWith('.json')).map((f) => ({ file: f, record: JSON.parse(readFileSync(join(resultsDir, f), 'utf8')) }))
  : []

for (const { file, record } of records)
describe(`experiment 03, as recorded in ${file}`, () => {
  it('was run against the vector set as committed', () => {
    for (const [f, h] of Object.entries(record.vectors)) expect(sha(f)).toBe(h)
  })
  it('pins every implementation at a full commit', () => {
    for (const pin of Object.values(record.pins) as { commit: string }[]) expect(pin.commit).toMatch(/^[0-9a-f]{40}$/)
  })
  it('lists exactly the answers that differ from the expected values', () => {
    const want = (f: string) => new Map(load(f).cases.map((c: { name: string }) => [c.name, c]))
    const tx = want('transactions.json')
    const rej = want('reject.json')
    const dig = want('execution-digest.json')
    for (const r of record.results) {
      const misses: string[] = []
      for (const a of r.answers.transactions)
        for (const f of ['raw', 'hash', 'sigHash'])
          if (String(a[f] ?? a.error).toLowerCase() !== (tx.get(a.name) as Record<string, string>)[f].toLowerCase())
            misses.push(`transactions/${a.name}/${f}`)
      for (const a of r.answers.reject) if (a.refused !== true && rej.has(a.name)) misses.push(`reject/${a.name}/refused`)
      for (const a of r.answers.executionDigest)
        for (const f of ['domainSeparator', 'structHash', 'executionDigest'])
          if (String(a[f] ?? a.error).toLowerCase() !== (dig.get(a.name) as Record<string, string>)[f].toLowerCase())
            misses.push(`execution-digest/${a.name}/${f}`)
      const recorded = r.misses.map((m: { file: string; name: string; field: string }) => `${m.file}/${m.name}/${m.field}`)
      expect(misses.sort()).toEqual(recorded.sort())
      expect(r.answers.transactions).toHaveLength(tx.size)
      expect(r.answers.reject).toHaveLength(rej.size)
      expect(r.answers.executionDigest).toHaveLength(dig.size)
    }
  })
})
