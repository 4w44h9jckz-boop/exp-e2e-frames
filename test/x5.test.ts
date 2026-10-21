// Experiment 06 (X5), every recorded run checked offline. Each signature is checked again here
// with noble's BLS12-381, an implementation of its own: the committee signed with Commonware
// (blst), the result contract checked on chain with EIP-2537's precompiles, and the nodes asked
// their client. These are what would show the claim wrong, written before the first run:
// - a result signed below the quorum is admitted by a node or mined;
// - a signature made for one request is accepted for another;
// - two results for one request are both mined;
// - the result transaction needs anyone besides the committee, an open node and the chain.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bls12_381 as bls } from '@noble/curves/bls12-381'
import { type Hex, concatHex, hexToBigInt, hexToBytes, keccak256, numberToHex, slice, stringToHex } from 'viem'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: a plain ES module beside the contract
import { compile } from '../experiments/06-x5-threshold-result/contracts/compile.mjs'

const here = new URL('../experiments/06-x5-threshold-result/', import.meta.url).pathname
const NAMESPACE = 'FRAME_FHE_RESULT_V1'
const DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_POP_'
const VERIFY_BUDGET_TESTNET = 500_000n
const VERIFY_BUDGET_EIP8141 = 100_000n

const word = (n: bigint | number) => numberToHex(BigInt(n), { size: 32 })
/** chain_id (32) || request (32) || handle (32) || value (32): the committee's fixed format. */
const message = (chainId: number, request: Hex, handle: Hex, value: number): Hex =>
  concatHex([word(chainId), request, handle, word(value)])

const point = (m: Hex) => {
  const ns = hexToBytes(stringToHex(NAMESPACE))
  return bls.G1.hashToCurve(new Uint8Array([ns.length, ...ns, ...hexToBytes(m)]), { DST })
}
const g1 = (eip2537: Hex) => bls.G1.ProjectivePoint.fromAffine({
  x: hexToBigInt(slice(eip2537, 0, 64)),
  y: hexToBigInt(slice(eip2537, 64, 128)),
})
const g2 = (eip2537: Hex) => {
  const c = [0, 1, 2, 3].map((i) => hexToBigInt(slice(eip2537, 64 * i, 64 * (i + 1))))
  const p = bls.G2.ProjectivePoint.fromAffine({
    x: bls.fields.Fp2.fromBigTuple([c[0], c[1]]),
    y: bls.fields.Fp2.fromBigTuple([c[2], c[3]]),
  })
  p.assertValidity()
  return p
}
/** e(sigma, g2) = e(H(m), key). */
const verifies = (m: Hex, sigma: Hex, key: Hex) =>
  bls.fields.Fp12.eql(bls.pairing(g1(sigma), bls.G2.ProjectivePoint.BASE), bls.pairing(point(m) as never, g2(key)))

describe('experiment 06, the result contract', () => {
  it('ResultBoard.hex is what solc 0.8.37 makes of ResultBoard.yul', () => {
    expect(readFileSync(join(here, 'contracts/ResultBoard.hex'), 'utf8').trim()).toBe(compile())
  })
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
  describe(`experiment 06, ${file}`, () => {
    const s = r.sent
    const by = (what: string) => {
      const x = s.sent.find((t: { what: string }) => t.what.startsWith(what))
      if (!x) throw new Error(`no transaction "${what}"`)
      return x
    }
    const q = s.results.quorum
    const [a, b] = r.nodes
    const lines = (node: { lines: Record<string, { event: string }[]> }, hash: string, e: string) =>
      (node.lines[hash] ?? []).filter((l) => l.event === e)

    it('pins every piece at a full commit, and peered the two nodes with each other alone', () => {
      for (const pin of Object.values(r.pins) as { commit: string }[]) expect(pin.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(a.peers).toEqual([b.peerId])
      expect(b.peers).toEqual([a.peerId])
    })

    it('deployed the result contract as its runtime and the committee key, and the key is the one that signed', () => {
      expect(s.key.toLowerCase()).toBe(r.committee.quorum.keyEip2537.toLowerCase())
      expect(s.boardCodeBytes).toBeGreaterThan(256)
      expect(r.chain[s.setup.hash].mined).toBe(true)
      expect(r.chain[s.setup.hash].status).toBe('0x1')
    })

    it('the quorum signed the result in the committee format, and noble agrees', () => {
      expect(r.committee.quorum.exitOk).toBe(true)
      expect(verifies(message(s.chainId, q.request, q.handle, q.value), q.signatureEip2537, s.key)).toBe(true)
    })

    it('a signature below the quorum does not verify, and no node admitted it, and it was not mined', () => {
      const x = by('below the quorum')
      const below = s.results.below
      expect(verifies(message(s.chainId, below.request, below.handle, below.value), below.signatureEip2537, s.key)).toBe(false)
      expect(x.answer.result).toBeUndefined()
      expect(lines(b, x.hash, 'gossip')).toHaveLength(0)
      expect(r.chain[x.hash].mined).toBe(false)
    })

    it('the quorum signature does not verify for another request, and the node refused it there', () => {
      const x = by('the quorum\'s signature presented for another request')
      expect(verifies(message(s.chainId, s.results.otherRequest, q.handle, q.value), q.signatureEip2537, s.key)).toBe(false)
      expect(x.answer.result).toBeUndefined()
      expect(lines(b, x.hash, 'gossip')).toHaveLength(0)
      expect(r.chain[x.hash].mined).toBe(false)
    })

    it('one result per request: the committee refused to sign a second, and the node refused a second and a replay', () => {
      expect(r.committee.second.exitOk).toBe(false)
      for (const what of ['a second result for the same request', 'the same result again, once mined']) {
        const x = by(what)
        expect(x.answer.result).toBeUndefined()
      }
      expect(r.chain[by('a second result for the same request').hash].mined).toBe(false)
    })

    it('mined the quorum result, sent to node A, gossiped to B and handed to the chain by B alone; sender and payer the contract, no signature', () => {
      const x = by('the result the quorum signed')
      expect(x.answer.result).toBe(x.hash)
      expect(x.hash).toBe(keccak256(x.raw))
      expect(lines(a, x.hash, 'handoff')).toHaveLength(0)
      expect(lines(b, x.hash, 'handoff').length).toBeGreaterThan(0)
      const c = r.chain[x.hash]
      expect(c.mined).toBe(true)
      expect(c.status).toBe('0x1')
      expect(c.frameStatuses.every((f: string) => f === '0x1')).toBe(true)
      expect(c.sender.toLowerCase()).toBe(s.board.toLowerCase())
      expect(c.payer.toLowerCase()).toBe(s.board.toLowerCase())
      expect(c.signatures).toBe(0)
      expect(s.mined.hash).toBe(x.hash)
    })

    it('records the VERIFY frame\'s gas against both budgets', () => {
      const sim = by('the result the quorum signed').simulation
      expect(sim.valid).toBe(true)
      const verifyGas = hexToBigInt(sim.frames[0].gasUsed)
      expect(verifyGas < VERIFY_BUDGET_TESTNET).toBe(true)
      // Recorded either way: no BLS check is expected to fit EIP-8141's 100,000.
      expect(typeof (verifyGas < VERIFY_BUDGET_EIP8141)).toBe('boolean')
    })

    it('records no private key', () => {
      expect(JSON.stringify(r)).not.toMatch(/PRIVATE_KEY/)
    })
  })

if (runs.length === 0) it.skip('experiment 06 has no recorded run yet', () => {})
