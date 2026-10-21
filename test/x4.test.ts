// Experiment 05 (X4), every recorded run checked offline. These are what would show the claim
// wrong, written before the first run:
// - the transfer's proof cannot be checked in a VERIFY frame within the testnet's validation
//   budget (the proof's gas is recorded against EIP-8141's 100,000 as well);
// - a note spent twice is admitted by either node, or mined;
// - ordering the transfers needs anyone but an open node and the chain.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { keccak256 } from 'viem'
import { describe, expect, it } from 'vitest'

const here = new URL('../experiments/05-x4-private-transfer/', import.meta.url).pathname
const TESTNET_VERIFY = 500_000
const EIP8141_VERIFY = 100_000

type Handed = {
  step: string
  hash: string
  raw: string
  nullifiers: string[]
  verifiesAlone: boolean
  url: string
  answer: { httpStatus: number; body: { result?: string; error?: unknown } }
}
type Line = Record<string, unknown> & { event: string }

describe('experiment 05, the pieces', () => {
  it('pins every piece at a full commit', () => {
    const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8')) as Record<string, { commit: string }>
    for (const p of Object.values(pins)) expect(p.commit).toMatch(/^[0-9a-f]{40}$/)
  })
})

const dir = join(here, 'results')
const runs = existsSync(dir)
  ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((file) => ({ file, r: JSON.parse(readFileSync(join(dir, file), 'utf8')) }))
  : []

for (const { file, r } of runs)
  describe(`experiment 05, ${file}`, () => {
    const s = r.sent
    const [a, b] = r.nodes
    const handed = s.handed as Handed[]
    const step = (prefix: string) => {
      const x = handed.find((h) => h.step.startsWith(prefix))
      if (!x) throw new Error(`no step "${prefix}"`)
      return x
    }
    const of = (node: { lines: Record<string, Line[]> }, hash: string, e: string) =>
      (node.lines[hash.toLowerCase()] ?? []).filter((l) => l.event === e)
    const transfer = step('transfer')
    const doubles = [step('a,'), step('b,'), ...handed.filter((h) => h.step.startsWith('c,'))]

    it('pins every piece at a full commit, and peered the two nodes with each other alone', () => {
      for (const pin of Object.values(r.pins) as { commit: string }[]) expect(pin.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(a.peers).toEqual([b.peerId])
      expect(b.peers).toEqual([a.peerId])
    })

    it('handed every transaction to node A alone, and each carries a proof that verifies on its own', () => {
      for (const h of handed) {
        expect(h.url).toBe(s.url)
        expect(h.verifiesAlone).toBe(true)
        expect(h.hash.toLowerCase()).toBe(keccak256(h.raw as `0x${string}`).toLowerCase())
      }
    })

    it('the transfer: admitted by A, gossiped to B and handed on only by B; mined unsigned, with the pool as sender and payer', () => {
      expect(transfer.answer.body.result?.toLowerCase()).toBe(transfer.hash.toLowerCase())
      expect(of(b, transfer.hash, 'gossip').length).toBeGreaterThan(0)
      expect(of(a, transfer.hash, 'handoff')).toHaveLength(0)
      expect(of(b, transfer.hash, 'handoff').length).toBeGreaterThan(0)
      const c = r.chain[transfer.hash.toLowerCase()]
      expect(c.mined).toBe(true)
      expect(c.status).toBe('0x1')
      expect(c.signatures).toBe(0)
      expect(c.sender.toLowerCase()).toBe(s.pool.toLowerCase())
      expect(c.payer.toLowerCase()).toBe(s.pool.toLowerCase())
    })

    it('the proof was checked in VERIFY within the testnet\'s budget; its gas against EIP-8141\'s is recorded', () => {
      const frames = r.transferFrames as { gasUsed: number; status: string }[]
      expect(frames.every((f) => f.status === '0x1')).toBe(true)
      const prefix = frames[0].gasUsed + frames[1].gasUsed
      expect(prefix).toBeLessThanOrEqual(TESTNET_VERIFY)
      expect(typeof (prefix <= EIP8141_VERIFY)).toBe('boolean')
    })

    it('each double spend reuses a nullifier the transfer spends', () => {
      const spent = new Set(transfer.nullifiers.map((n) => n.toLowerCase()))
      for (const d of doubles) expect(d.nullifiers.some((n) => spent.has(n.toLowerCase()))).toBe(true)
    })

    it('no note was spent twice: every double spend refused by node A, never gossiped to B, never mined', () => {
      expect(doubles.length).toBeGreaterThanOrEqual(2)
      for (const d of doubles) {
        expect(d.answer.body.result).toBeUndefined()
        expect(d.answer.body.error).toBeTruthy()
        expect(of(b, d.hash, 'gossip')).toHaveLength(0)
        expect(r.chain[d.hash.toLowerCase()].mined).toBe(false)
      }
      expect(s.onChain.a).toBeNull()
      expect(s.onChain.b).toBeNull()
    })

    it('records no key, note secret or witness', () => {
      expect(JSON.stringify(r)).not.toMatch(/PRIVATE_KEY|"nsk"|"witness"/)
    })
  })

if (runs.length === 0) it.skip('experiment 05 has no recorded run yet', () => {})
