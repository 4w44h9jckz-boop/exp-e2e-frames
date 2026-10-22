// Experiment 07 (X6), every recorded run checked offline. These are what would show the claim
// wrong, written before the first run:
// - the committee's withdrawal differs from a device-proved one in anything a node or the verifier
//   sees, beyond the proof's own random points;
// - the shared-state update needs more in its prefix than the committee's proof and a payer's
//   approval;
// - after the committee stops, a user can still move a balance it held.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { keccak256 } from 'viem'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: a plain ES module beside the contract
import { compile } from '../experiments/07-x6-committee-proof/contracts/compile.mjs'

const here = new URL('../experiments/07-x6-committee-proof/', import.meta.url).pathname
const VERIFY = '0x1'
const SENDER = '0x2'
const EXECUTION = '0x2'
const PAYMENT = '0x1'
const CREDIT = '0x90f7dbd5'

describe('experiment 07, the committee account', () => {
  it('CommitteeAccount.hex is what solc 0.8.37 makes of CommitteeAccount.yul', () => {
    expect(readFileSync(join(here, 'contracts/CommitteeAccount.hex'), 'utf8').trim()).toBe(compile())
  })
  it('pins every piece at a full commit', () => {
    const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8')) as Record<string, { commit: string }>
    for (const p of Object.values(pins)) expect(p.commit).toMatch(/^[0-9a-f]{40}$/)
  })
})

type Frame = { mode: string; flags: string; to: string | null; gasLimit: string; stateGasLimit: string; value: string; dataBytes: number; selector: string | null }
type Facts = { sender: string; nonceKeys: string[]; maxFeePerGas: string; maxPriorityFeePerGas: string; signatures: number; signatureEntries: { scheme: string; signer: string | null; msg: string; bytes: number }[]; frames: Frame[] }

const dir = join(here, 'results')
const runs = existsSync(dir)
  ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((file) => ({ file, r: JSON.parse(readFileSync(join(dir, file), 'utf8')) }))
  : []

/** The fee, charge and refund on the device example's last line, in wei. */
const costLine = (line: string) => {
  const m = line.match(/^fee (\d+) wei; charged (\d+); refunded (\d+)/)
  if (!m) throw new Error(`no cost in: ${line}`)
  const [fee, charged, refunded] = m.slice(1).map(BigInt)
  return { fee, charged, refunded, net: fee - refunded }
}

for (const { file, r } of runs.filter((x) => x.r.addendum !== 'pricing'))
  describe(`experiment 07, ${file}`, () => {
    const [a, b] = r.nodes
    const lines = (node: { lines: Record<string, { event: string }[]> }, hash: string, e: string) =>
      (node.lines[hash.toLowerCase()] ?? []).filter((l) => l.event === e)
    const chain = (h: string) => r.chain[h.toLowerCase()]
    const sentTo = (hash: string) => {
      expect(lines(a, hash, 'rpc').length).toBeGreaterThan(0)
      expect(lines(b, hash, 'rpc')).toHaveLength(0)
      expect(lines(b, hash, 'gossip').length).toBeGreaterThan(0)
      expect(lines(a, hash, 'handoff')).toHaveLength(0)
      expect(lines(b, hash, 'handoff').length).toBeGreaterThan(0)
    }
    const refused = (s: { hash: string; answer: { result?: string; error?: string } }) => {
      expect(s.answer.result).toBeUndefined()
      expect(s.answer.error).toBeTruthy()
      expect(lines(b, s.hash, 'gossip')).toHaveLength(0)
      expect(chain(s.hash).mined).toBe(false)
    }
    // A replay has the mined transaction's hash, so only the node's answer tells it apart.
    const refusedAgain = (s: { answer: { result?: string; error?: string } }) => {
      expect(s.answer.result).toBeUndefined()
      expect(s.answer.error).toBeTruthy()
    }

    it('pins every piece at a full commit, and peered the two nodes with each other alone', () => {
      for (const pin of Object.values(r.pins) as { commit: string }[]) expect(pin.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(a.peers).toEqual([b.peerId])
      expect(b.peers).toEqual([a.peerId])
    })

    it('the three members agreed on one proof, and each checked it', () => {
      for (const members of [r.committee.members, r.update.members]) {
        expect(members.map((m: { member: number }) => m.member)).toEqual([0, 1, 2])
        for (const m of members) {
          expect(m.verified).toBe(true)
          expect(m.solidity).toBe(members[0].solidity)
          expect(m.network).toMatch(/loopback/)
        }
      }
    })

    it('both withdrawals: sent to node A, gossiped to B and handed on by B alone, mined unsigned with the pool as sender and payer', () => {
      const committee = r.committee.withdrawal.sent[0]
      expect(committee.answer.result).toBe(committee.hash)
      expect(committee.hash).toBe(keccak256(committee.raw))
      for (const h of [r.device.withdrawal, committee.hash]) {
        sentTo(h)
        const c = chain(h)
        expect(c.mined).toBe(true)
        expect(c.status).toBe('0x1')
        expect(c.signatures).toBe(0)
        expect(c.sender.toLowerCase()).toBe(c.payer.toLowerCase())
        expect(c.frameStatuses.every((s: string) => s === '0x1')).toBe(true)
      }
      expect(chain(r.device.withdrawal).sender.toLowerCase()).toBe(chain(committee.hash).sender.toLowerCase())
    })

    it('the verifier accepts the committee\'s proof and the device\'s alike', () => {
      expect(r.device.verifierAccepts).toBe(true)
      expect(r.committee.verifierAccepts).toBe(true)
    })

    // Written before run 1 as the claim's first condition. Runs 2 and 3 showed it wrong, by the
    // wallet's pricing rather than the proof: kept verbatim, and expected to fail. The check after
    // it says exactly what matched and what did not.
    it.fails('a node sees the committee\'s withdrawal as it sees the device\'s: every frame, limit and fee field', () => {
      const d = r.device.frames as Facts
      const c = r.committee.frames as Facts
      const seen = (f: Facts) => ({
        signatures: f.signatures,
        nonceKeys: f.nonceKeys.length,
        maxFeePerGas: f.maxFeePerGas,
        maxPriorityFeePerGas: f.maxPriorityFeePerGas,
        frames: f.frames.map((x) => ({ mode: x.mode, flags: x.flags, to: x.to, gasLimit: x.gasLimit, stateGasLimit: x.stateGasLimit, value: x.value, dataBytes: x.dataBytes, selector: x.selector })),
      })
      expect(seen(c)).toEqual(seen(d))
    })

    it('shown wrong by the pricing, not the proof: shapes, targets, values, data and fee fields match; the limits differ', () => {
      const d = r.device.frames as Facts
      const c = r.committee.frames as Facts
      expect([c.signatures, c.nonceKeys.length, c.maxFeePerGas, c.maxPriorityFeePerGas]).toEqual([d.signatures, d.nonceKeys.length, d.maxFeePerGas, d.maxPriorityFeePerGas])
      const shape = (f: Facts) => f.frames.map((x) => ({ mode: x.mode, flags: x.flags, to: x.to, stateGasLimit: x.stateGasLimit, value: x.value, dataBytes: x.dataBytes, selector: x.selector }))
      expect(shape(c)).toEqual(shape(d))
      const limits = (f: Facts) => f.frames.map((x) => BigInt(x.gasLimit))
      // The wallet's shares are priced at the pool's default limits and the worst-case fee; the
      // device sets its limits from a simulation of its own proof.
      expect(limits(c)).not.toEqual(limits(d))
      expect(typeof r.committee.withdrawal.publicInputs.fee).toBe('string')
      expect(r.device.publicInputs).toHaveLength(6)
    })

    it('the same withdrawal again, once mined, was refused', () => {
      refusedAgain(r.committee.withdrawal.sent[1])
    })

    it('the update: the account\'s VERIFY with the proof, a payer\'s VERIFY, then the credit; nothing else in the prefix', () => {
      const f = r.update.frames as Facts
      const account = r.update.account.toLowerCase()
      expect(f.sender.toLowerCase()).toBe(account)
      expect(f.frames).toHaveLength(3)
      const [mine, payer, credit] = f.frames
      expect([mine.mode, mine.flags, mine.to]).toEqual([VERIFY, EXECUTION, null])
      expect(mine.dataBytes).toBe(320)
      expect([payer.mode, payer.flags]).toEqual([VERIFY, PAYMENT])
      expect(payer.to?.toLowerCase()).toBe(r.update.payer.toLowerCase())
      expect([credit.mode, credit.to?.toLowerCase(), credit.selector, credit.value]).toEqual([SENDER, account, CREDIT, '0x0'])
      expect(f.nonceKeys.map((k) => BigInt(k))).toEqual([BigInt(r.update.nullifierHash)])
      // Changed after run 1, before run 2: EIP-8141's default code reads a payment-only payer's
      // signature at index 1, so index 0 is an empty ARBITRARY entry the account never reads.
      const [none, paid] = f.signatureEntries
      expect(f.signatureEntries).toHaveLength(2)
      expect([none.scheme, none.bytes, none.msg]).toEqual(['0x0', 0, '0x'])
      expect([paid.scheme, paid.signer?.toLowerCase(), paid.msg]).toEqual(['0x1', r.update.payer.toLowerCase(), '0x'])
    })

    it('the update: sent to node A, gossiped to B, handed on by B alone, mined with the payer paying; the recipient credited once', () => {
      const s = r.update.sent[0]
      expect(s.answer.result).toBe(s.hash)
      sentTo(s.hash)
      const c = chain(s.hash)
      expect(c.mined).toBe(true)
      expect(c.status).toBe('0x1')
      expect(c.sender.toLowerCase()).toBe(r.update.account.toLowerCase())
      expect(c.payer.toLowerCase()).toBe(r.update.payer.toLowerCase())
      expect(c.frameStatuses.every((x: string) => x === '0x1')).toBe(true)
      expect(BigInt(r.update.recipientBalance)).toBe(1n)
      refusedAgain(r.update.sent[1])
    })

    it('the update\'s proof is the stand-in\'s: recipient as recorded, relayer, fee and refund zero', () => {
      const [, nullifierHash, recipient, relayer, fee, refund] = r.update.members[0].publicInputs.map(BigInt)
      expect(nullifierHash).toBe(BigInt(r.update.nullifierHash))
      expect(recipient).toBe(BigInt(r.update.recipient))
      expect([relayer, fee, refund]).toEqual([0n, 0n, 0n])
    })

    it('the committee stopped: one member alone cannot prove, the wallet kept no share, and the chain refuses the withdrawal unproved', () => {
      expect(r.stopped.memberAlone.exitOk).toBe(false)
      // Added after run 2, whose probe failed on its own command line and so tested nothing.
      expect(r.stopped.memberAlone.tail.join('\n')).not.toMatch(/Usage:|values required/)
      expect(r.stopped.walletKept.some((f: string) => /^share-/.test(f))).toBe(false)
      refused(r.stopped.unproved.sent[0])
    })

    it('records no key, share or note', () => {
      const all = JSON.stringify(r)
      expect(all).not.toMatch(/PRIVATE_KEY|note 0x/i)
    })
  })

// The pricing addendum, written in the README before its code or any transaction: under the
// wallet's new default, a node sees the same in both withdrawals but what the notes, recipients
// and proofs make differ, and the refund returns what the higher fee adds.
for (const { file, r } of runs.filter((x) => x.r.addendum === 'pricing'))
  describe(`experiment 07, ${file}, the pricing addendum`, () => {
    const [a, b] = r.nodes
    const lines = (node: { lines: Record<string, { event: string }[]> }, hash: string, e: string) =>
      (node.lines[hash.toLowerCase()] ?? []).filter((l) => l.event === e)
    const chain = (h: string) => r.chain[h.toLowerCase()]
    const committee = r.committee.withdrawal.sent[0]

    it('pins every piece at a full commit, and peered the two nodes with each other alone', () => {
      for (const pin of Object.values(r.pins) as { commit: string }[]) expect(pin.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(a.peers).toEqual([b.peerId])
      expect(b.peers).toEqual([a.peerId])
    })

    it('both withdrawals: each sent to node A, reaching B by gossip and leaving through B alone, mined unsigned with the pool as sender and payer; the verifier accepts both', () => {
      expect(committee.answer.result).toBe(committee.hash)
      expect(committee.hash).toBe(keccak256(committee.raw))
      for (const h of [r.device.withdrawal, committee.hash]) {
        expect(lines(a, h, 'rpc').length).toBeGreaterThan(0)
        expect(lines(b, h, 'gossip').length).toBeGreaterThan(0)
        expect(lines(a, h, 'handoff')).toHaveLength(0)
        expect(lines(b, h, 'handoff').length).toBeGreaterThan(0)
        const c = chain(h)
        expect([c.mined, c.status, c.signatures]).toEqual([true, '0x1', 0])
        expect(c.frameStatuses.every((s: string) => s === '0x1')).toBe(true)
      }
      expect(chain(r.device.withdrawal).sender.toLowerCase()).toBe(chain(committee.hash).sender.toLowerCase())
      expect([r.device.verifierAccepts, r.committee.verifierAccepts]).toEqual([true, true])
    })

    it('a node sees the committee\'s withdrawal as it sees the device\'s: every frame, limit and fee field', () => {
      const seen = (f: Facts) => ({
        signatures: f.signatures,
        nonceKeys: f.nonceKeys.length,
        maxFeePerGas: f.maxFeePerGas,
        maxPriorityFeePerGas: f.maxPriorityFeePerGas,
        frames: f.frames.map((x) => ({ mode: x.mode, flags: x.flags, to: x.to, gasLimit: x.gasLimit, stateGasLimit: x.stateGasLimit, value: x.value, dataBytes: x.dataBytes, selector: x.selector })),
      })
      expect(seen(r.committee.frames as Facts)).toEqual(seen(r.device.frames as Facts))
    })

    it('the fee the proof commits to is the same in both', () => {
      // withdraw(proof, root, nullifierHash, recipient, relayer, fee, refund): the fee is input 4.
      expect(BigInt(r.device.publicInputs[4])).toBe(BigInt(r.committee.withdrawal.publicInputs.fee))
    })

    it('the refund returns what the higher fee adds: the note\'s net cost rose by less than the whole rise in fee', () => {
      const now = costLine(r.device.stdout.find((l: string) => l.startsWith('fee ')))
      const before = costLine(r.run3Device[0])
      expect(now.refunded).toBeGreaterThan(0n)
      expect(now.net - before.net).toBeLessThan(now.fee - before.fee)
    })

    it('records no key, share or note', () => {
      expect(JSON.stringify(r)).not.toMatch(/PRIVATE_KEY|note 0x/i)
    })
  })

if (runs.length === 0) it.skip('experiment 07 has no recorded run yet', () => {})
