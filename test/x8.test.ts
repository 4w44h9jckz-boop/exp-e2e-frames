// Experiment 12 (X8), every recorded run checked offline. These are what would show the claim
// wrong, written before the first run:
// - against a bound ticket, a copy with its priority fee raised, or its calldata changed, is
//   admitted by either node or mined;
// - the bound original is refused by a node, or is not mined;
// - a node needs anything from the ticket's issuers to decide, or is told which paymasters bind;
// - the issuers can tell, from what they saw when signing, which transaction a ticket paid for.
// The control, the same copies against a ticket that names no key, is recorded, not judged: it
// shows what the binding has to stop.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { keccak256 } from 'viem'
import { describe, expect, it } from 'vitest'

const here = new URL('../experiments/12-x8-bound-ticket/', import.meta.url).pathname
/** The bound paymaster's template, as the profile names it (exp-mempool-l2s claim-gated version 7). */
const BOUND_TEMPLATE = '0x52c656815e560bb189c3fb362c9628432ca1ed6b720e239857775236c18bc1d3'

type Sent = { what: string; hash: string; raw: string; sent?: { result?: string; error?: string }; sentTo?: string; block?: string; payer?: string }
type Line = Record<string, unknown> & { event: string }

describe('experiment 12, the pieces', () => {
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
  describe(`experiment 12, ${file}`, () => {
    const s = r.sent
    const [a, b] = r.nodes
    const of = (node: { lines: Record<string, Line[]> }, hash: string, e: string) =>
      (node.lines[hash.toLowerCase()] ?? []).filter((l) => l.event === e)
    const binding = s.binding as Sent[]
    const control = s.control as Sent[]
    const copies = (s.calldataCopies ?? []) as Sent[]
    const original = binding[0]
    const boundCopies = binding.slice(1).filter((t) => !t.block)
    const boundCalldata = copies.filter((t) => t.what.startsWith('bound'))

    it('pins every piece at a full commit, ran both nodes with --frames.claims, peered with each other alone', () => {
      for (const pin of Object.values(r.pins) as { commit: string }[]) expect(pin.commit).toMatch(/^[0-9a-f]{40}$/)
      for (const n of r.nodes) expect(n.claims).toBe(true)
      expect(a.peers).toEqual([b.peerId])
      expect(b.peers).toEqual([a.peerId])
    })

    it('sent every spend, withdrawal and copy to node A, and nothing else told the nodes about the paymasters', () => {
      expect(s.sendRpcUrl).toBeTruthy()
      const handed = [...s.spends, ...control, ...binding, ...copies].filter((t: Sent) => t.sent) as Sent[]
      expect(handed.length).toBeGreaterThanOrEqual(control.filter((t) => t.sent).length + boundCopies.length + 2)
      for (const t of handed) expect(t.sentTo).toBe(s.sendRpcUrl)
      for (const n of r.nodes) expect(JSON.stringify(n.start)).not.toContain(s.boundPaymaster.slice(2).toLowerCase())
    })

    it('deployed the bound paymaster with the template the profile names', () => {
      expect(s.boundTemplate.keccak256 ?? s.boundTemplate.keccak ?? s.boundTemplate.hash).toBe(BOUND_TEMPLATE)
    })

    it('the bound original: admitted by node A, gossiped to B, handed on by B alone, and mined, paid by the bound paymaster', () => {
      expect(original.sent?.result?.toLowerCase()).toBe(original.hash.toLowerCase())
      expect(original.hash.toLowerCase()).toBe(keccak256(original.raw as `0x${string}`).toLowerCase())
      expect(of(b, original.hash, 'gossip').length).toBeGreaterThan(0)
      expect(of(a, original.hash, 'handoff')).toHaveLength(0)
      expect(of(b, original.hash, 'handoff').length).toBeGreaterThan(0)
      const c = r.chain[original.hash.toLowerCase()]
      expect(c.mined).toBe(true)
      expect(c.status).toBe('0x1')
      expect(c.payer.toLowerCase()).toBe(s.boundPaymaster.toLowerCase())
    })

    it('every copy against the bound ticket: refused by node A, never gossiped to B, never mined', () => {
      expect(boundCopies.length).toBeGreaterThanOrEqual(3)
      expect(boundCalldata.length).toBe(1)
      for (const t of [...boundCopies, ...boundCalldata]) {
        expect(t.sent?.result).toBeUndefined()
        expect(t.sent?.error).toBeTruthy()
        expect(of(b, t.hash, 'gossip')).toHaveLength(0)
        expect(r.chain[t.hash.toLowerCase()].mined).toBe(false)
      }
    })

    it('the control is recorded: what the unbound ticket let a copy do', () => {
      expect(control.length).toBeGreaterThan(0)
      const mined = control.filter((t) => t.block)
      expect(mined.length).toBe(1)
      // Recorded, not judged: which of the control's transactions the chain kept.
      expect(typeof r.chain[mined[0].hash.toLowerCase()].mined).toBe('boolean')
    })

    it('the issuers saw no binder', () => {
      const binders = (s.tickets.bound as { binder: string }[]).map((t) => t.binder.slice(2).toLowerCase())
      const seen = JSON.stringify(s.issuers).toLowerCase()
      for (const x of binders) expect(seen).not.toContain(x)
    })

    it('records no key, seed or mnemonic', () => {
      const all = JSON.stringify(r)
      expect(all).not.toMatch(/PRIVATE_KEY|mnemonic|SEED_FILE/i)
    })
  })

if (runs.length === 0) it.skip('experiment 12 has no recorded run yet', () => {})
