// Every recorded run, checked offline against what its experiment claims. A run expected to be
// mined must show the whole path in its own logs: admitted by the first node and relayed, received
// by gossip from that node's peer ID and handed to the client by the second node alone, removed by
// both as included, and mined with no signature, its sender paying.
import { describe, expect, it } from 'vitest'
import { readRecords } from '../src/e2e/record.js'

const runs = readRecords()
const ev = (lines: Record<string, unknown>[], e: string) => lines.filter((l) => l.event === e)

describe.runIf(runs.length > 0)('recorded runs', () => {
  for (const { file, record } of runs) {
    const [a, b] = record.nodes
    const hash = file.replace(/\.json$/, '').toLowerCase()
    describe(`${record.experiment}, ${record.attempt} (${file.slice(0, 12)})`, () => {
      it('pins every piece at a full commit', () => {
        for (const pin of Object.values(record.pins)) expect(pin.commit).toMatch(/^[0-9a-f]{40}$/)
      })
      it('has two nodes, each the other\'s only peer', () => {
        expect(record.nodes).toHaveLength(2)
        expect(a.peers).toEqual([b.peerId])
        expect(b.peers).toEqual([a.peerId])
      })
      it('never hands the transaction to a client from the first node', () => {
        expect(a.handoff).toBe(false)
        expect(ev(a.lines, 'handoff')).toHaveLength(0)
      })
      if (record.inclusionLists?.length) {
        it('keeps every inclusion list it recorded within its budget and its size', () => {
          for (const { list } of record.inclusionLists!) {
            expect(BigInt(list.verifyGas) <= BigInt(list.budget)).toBe(true)
            expect(list.bytes).toBeLessThanOrEqual(8192)
            expect(list.transactions).toHaveLength(list.hashes.length)
          }
        })
      }
      if (record.expectListed) {
        it('was listed by an includer under a budget per list', () => {
          const listed = record.inclusionLists!.filter(
            (l) => l.focil === 'eip-8369' && l.list.hashes.map((h) => h.toLowerCase()).includes(hash),
          )
          expect(listed.length).toBeGreaterThan(0)
        })
      }
      if (record.expect === 'mined') {
        it('is admitted by the first node on the client\'s verdict and relayed', () => {
          expect(ev(a.lines, 'rpc').some((l) => l.result === 'ok' && l.client === 'valid')).toBe(true)
          expect(ev(a.lines, 'relay').some((l) => Number(l.peers) >= 1)).toBe(true)
        })
        it('reaches the second node by gossip from the first, which hands it to the client', () => {
          expect(ev(b.lines, 'gossip').some((l) => l.from === a.peerId && l.outcome === 'accept')).toBe(true)
          expect(ev(b.lines, 'handoff')).toHaveLength(1)
        })
        it('is removed by both nodes as included', () => {
          for (const n of record.nodes)
            expect(ev(n.lines, 'head').some((l) => (l.removed as string[]).map((r) => r.toLowerCase()).includes(hash))).toBe(true)
        })
        it('is mined with no signature, its sender paying', () => {
          expect(record.chain.mined).toBe(true)
          expect(record.chain.status).toBe('0x1')
          expect(record.chain.signatures).toBe(0)
          expect(String(record.chain.payer).toLowerCase()).toBe(String(record.chain.sender).toLowerCase())
        })
      } else {
        it('is refused by the first node and goes no further', () => {
          expect(ev(a.lines, 'rpc').some((l) => l.result !== 'ok')).toBe(true)
          expect(ev(a.lines, 'relay')).toHaveLength(0)
          expect(b.lines).toHaveLength(0)
          expect(record.chain.mined).toBe(false)
        })
      }
    })
  }
})

it('reads the runs directory', () => {
  expect(Array.isArray(runs)).toBe(true)
})
