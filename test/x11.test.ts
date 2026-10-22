// Experiment 11 (X7), every recorded run checked offline. These are what would show the claim
// wrong, written before the first run:
// - a step after the loss needs a party other than the guardians, the user's phrase, an open
//   node and the chain;
// - something the old device could spend cannot be spent from the new one;
// - the seed given back is not the seed that was lost, or the reopened backup's differs.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { keccak256 } from 'viem'
import { english } from 'viem/accounts'
import { describe, expect, it } from 'vitest'

const here = new URL('../experiments/11-x7-recovery/', import.meta.url).pathname

describe('experiment 11, the pieces', () => {
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
  describe(`experiment 11, ${file}`, () => {
    const [a, b] = r.nodes
    const lines = (node: { lines: Record<string, { event: string }[]> }, hash: string, e: string) =>
      (node.lines[hash.toLowerCase()] ?? []).filter((l) => l.event === e)
    const byMode = (mode: string) => r.steps.find((s: { mode: string }) => s.mode === mode)
    const afterLoss = ['recover', 'reopen', 'restore']

    it('pins every piece at a full commit, and peered the two nodes with each other alone', () => {
      for (const pin of Object.values(r.pins) as { commit: string }[]) expect(pin.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(a.peers).toEqual([b.peerId])
      expect(b.peers).toEqual([a.peerId])
    })

    it('ran the steps in their authors\' order, the funder only before the loss', () => {
      expect(r.steps.map((s: { mode: string }) => s.mode)).toEqual(['build', 'setup', 'write', ...afterLoss])
      for (const s of r.steps) expect(s.ok).toBe(true)
      for (const m of afterLoss) expect(byMode(m).withFunder).toBe(false)
    })

    it('the guardians and the phrase gave back the lost seed, and so did the reopened backup', () => {
      expect(r.seeds).toEqual({ recoveredEqualsLost: true, reopenedEqualsLost: true })
    })

    it('the new device spent the pool note, a ticket and the account: each went to node A, reached B by gossip, left through B alone, and was mined', () => {
      const spends = byMode('restore').record.spends
      expect(spends).toHaveLength(3)
      for (const s of spends) {
        expect(s.answer.result?.toLowerCase()).toBe(s.hash.toLowerCase())
        expect(s.hash.toLowerCase()).toBe(keccak256(s.raw).toLowerCase())
        expect(lines(a, s.hash, 'rpc').length).toBeGreaterThan(0)
        expect(lines(b, s.hash, 'gossip').length).toBeGreaterThan(0)
        expect(lines(a, s.hash, 'handoff')).toHaveLength(0)
        expect(lines(b, s.hash, 'handoff').length).toBeGreaterThan(0)
        const c = r.chain[s.hash.toLowerCase()]
        expect(c.mined).toBe(true)
        expect(c.status).toBe('0x1')
        expect(c.frameStatuses.every((x: string) => x === '0x1')).toBe(true)
      }
    })

    it('records no key, seed or phrase: no PRIVATE_KEY, and nowhere twelve BIP-39 words in a row', () => {
      const all = JSON.stringify(r)
      expect(all).not.toMatch(/PRIVATE_KEY|note 0x/i)
      const set = new Set(english)
      let run = 0
      let longest = 0
      for (const w of all.toLowerCase().split(/[^a-z]+/)) {
        run = set.has(w) ? run + 1 : 0
        longest = Math.max(longest, run)
      }
      expect(longest).toBeLessThan(12)
    })
  })

if (runs.length === 0) it.skip('experiment 11 has no recorded run yet', () => {})
