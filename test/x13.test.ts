// Experiment 13 (G5), every recorded run checked offline. The predicted cells this run can
// measure are written as checks before the first run; a cell the run cannot measure is not
// checked here, and the README says which.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bls12_381 as bls } from '@noble/curves/bls12-381'
import { type Hex, concatHex, hexToBigInt, hexToBytes, numberToHex, slice, stringToHex } from 'viem'
import { describe, expect, it } from 'vitest'

const here = new URL('../experiments/13-g5-gradient/', import.meta.url).pathname
/** experiment 52's README, "The proving key". */
const ZKEY_SHA256 = 'd12e609f8fda977e1000ea59b1362ae26b3bc4a28a3de9c9df9517b75190fd3f'
const NAMESPACE = 'FRAME_FHE_RESULT_V1'
const DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_POP_'

const word = (n: bigint | number) => numberToHex(BigInt(n), { size: 32 })
const point = (m: Hex) => {
  const ns = hexToBytes(stringToHex(NAMESPACE))
  return bls.G1.hashToCurve(new Uint8Array([ns.length, ...ns, ...hexToBytes(m)]), { DST })
}
const g1 = (e: Hex) => bls.G1.ProjectivePoint.fromAffine({ x: hexToBigInt(slice(e, 0, 64)), y: hexToBigInt(slice(e, 64, 128)) })
const g2 = (e: Hex) => {
  const c = [0, 1, 2, 3].map((i) => hexToBigInt(slice(e, 64 * i, 64 * (i + 1))))
  return bls.G2.ProjectivePoint.fromAffine({ x: bls.fields.Fp2.fromBigTuple([c[0], c[1]]), y: bls.fields.Fp2.fromBigTuple([c[2], c[3]]) })
}
/** The committee's message, chain ID || request || handle || value, checked with noble. */
const verifies = (chainId: number, s: { request: Hex; handle: Hex; value: number; signatureEip2537: Hex }, key: Hex) =>
  bls.fields.Fp12.eql(
    bls.pairing(g1(s.signatureEip2537), bls.G2.ProjectivePoint.BASE),
    bls.pairing(point(concatHex([word(chainId), s.request, s.handle, word(s.value)])) as never, g2(key)),
  )

describe('experiment 13, the pieces', () => {
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
  describe(`experiment 13, ${file}`, () => {
    const [a, b] = r.nodes
    const lines = (node: { lines: Record<string, { event: string }[]> }, hash: string, e: string) =>
      (node.lines[hash.toLowerCase()] ?? []).filter((l) => l.event === e)
    const chain = (h: string) => r.chain[h.toLowerCase()]
    const viaA = (h: string) => {
      expect(lines(a, h, 'rpc').length).toBeGreaterThan(0)
      expect(lines(b, h, 'gossip').length).toBeGreaterThan(0)
      expect(lines(a, h, 'handoff')).toHaveLength(0)
      expect(lines(b, h, 'handoff').length).toBeGreaterThan(0)
    }
    const refusedAtA = (s: { hash: string; answer: { result?: string; error?: string } }) => {
      expect(s.answer.result).toBeUndefined()
      expect(s.answer.error).toBeTruthy()
      expect(lines(b, s.hash, 'gossip')).toHaveLength(0)
      expect(chain(s.hash).mined).toBe(false)
    }
    const m = r.mpc
    const last = m.attempts[m.attempts.length - 1]

    it('pins every piece at a full commit, peered the two nodes with each other alone, and used experiment 52\'s key', () => {
      for (const pin of Object.values(r.pins) as { commit: string }[]) expect(pin.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(a.peers).toEqual([b.peerId])
      expect(b.peers).toEqual([a.peerId])
      expect(m.zkey.sha256).toBe(ZKEY_SHA256)
    })

    it('the MPC committee: a wrong guess of the bit stops the witness at the circuit\'s check, which opens one bit', () => {
      expect(m.attempts[0].guess).toBe(0)
      if (m.out === 1) {
        expect(m.attempts[0].witness.every((w: { ok: boolean }) => !w.ok)).toBe(true)
        for (const w of m.attempts[0].witness) expect(w.tail.join('\n')).toMatch(/Assertion failed .* line 73/)
      }
      expect(last.witness.every((w: { ok: boolean }) => w.ok)).toBe(true)
    })

    it('the MPC committee: three members agree on one proof of experiment 52\'s statement, and it verifies', () => {
      expect(last.membersAgree).toBe(true)
      expect(last.verify.ok).toBe(true)
      expect(last.publicSignals).toEqual([r.function.Ca, r.function.Cb, r.function.session, String(m.out)])
    })

    it('who sees the plaintext, MPC: any two consecutive members\' input shares rebuild both bids', () => {
      expect(last.rebuilt).toHaveLength(6)
      for (const x of last.rebuilt) expect(x.rebuilds).toBe(true)
    })

    it('who must be online, MPC: two members without the third make no witness', () => {
      expect(m.twoMembers).toHaveLength(2)
      for (const w of m.twoMembers) expect(w.ok).toBe(false)
    })

    it('the MPC settlement: sent to node A, gossiped, handed on by B alone, mined with SealedPair as sender and payer; the bit flipped is refused', () => {
      viaA(m.settle.hash)
      const c = chain(m.settle.hash)
      expect(c.mined).toBe(true)
      expect(c.status).toBe('0x1')
      expect(c.sender.toLowerCase()).toBe(r.function.sealedPair.toLowerCase())
      expect(c.payer.toLowerCase()).toBe(r.function.sealedPair.toLowerCase())
      expect(c.signatures).toBe(0)
      refusedAtA(m.flipped)
    })

    it('the FHE committee: both proofs checked, the comparison decrypted by all four members, the same bit as the MPC committee', () => {
      expect(r.fhe.steps.every((s: { ok: boolean }) => s.ok)).toBe(true)
      expect(r.fhe.decryption.value).toBe(m.out)
      expect(r.fhe.decryption.members).toHaveLength(4)
      for (const x of r.fhe.decryption.members) expect(x.bytesSent).toBeGreaterThan(0)
    })

    it('the FHE committee: a quorum\'s signature verifies with noble, two members\' does not, and the committee would not sign the other bit', () => {
      const s = r.fhe.result
      expect(verifies(s.chainId, s.results.quorum, s.key)).toBe(true)
      expect(verifies(s.chainId, s.results.below, s.key)).toBe(false)
      expect(r.fhe.second.refusals.length).toBeGreaterThan(0)
    })

    it('the FHE result: sent to node A, gossiped, handed on by B alone, mined; the variants refused', () => {
      const s = r.fhe.result
      const by = (what: string) => s.sent.find((t: { what: string }) => t.what.startsWith(what))
      const x = by('the result the quorum signed')
      viaA(x.hash)
      expect(chain(x.hash).mined).toBe(true)
      expect(chain(x.hash).status).toBe('0x1')
      for (const v of ['below the quorum', 'the quorum\'s signature presented for another request', 'a second result for the same request']) refusedAtA(by(v))
      expect(by('the same result again, once mined').answer.result).toBeUndefined()
    })

    it('the carried steps read back from the chain as their records say', () => {
      const c = r.carried
      const s1 = c['direct coordination: experiment 52, S1, the joint proof settled']
      expect([s1.mined, s1.status, s1.block, s1.gasUsed]).toEqual([true, '0x1', 491469, 493099])
      expect(s1.frames[1].gasUsed).toBe(220481)
      const att = c['enclave: experiment 51, A, the output on its attestation']
      expect([att.status, att.gasUsed, att.frames[0].gasUsed]).toEqual(['0x1', 152278, 9696])
      const prf = c['enclave: experiment 51, B, the output on its proof']
      expect([prf.status, prf.gasUsed, prf.frames[0].gasUsed]).toEqual(['0x1', 368405, 245699])
    })

    it('records no key, randomness, share or bid secret', () => {
      const all = JSON.stringify(r)
      expect(all).not.toMatch(/PRIVATE_KEY|"ra"|"rb"|note 0x/)
    })
  })

if (runs.length === 0) it.skip('experiment 13 has no recorded run yet', () => {})
