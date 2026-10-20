// Experiment 04 (X3), every recorded run checked offline. Each ticket is checked again here with
// noble's BLS12-381, an implementation of its own: kohaku-rs's issuers signed with Commonware
// (blst), the paymasters checked on chain with EIP-2537's precompiles, and skandha checked before
// it asked its client. The nodes' log lines must show the junk refused without the client asked,
// and every spend admitted by both nodes, handed to the chain by the second alone, and paid by the
// paymaster of the set that issued its ticket.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bls12_381 as bls } from '@noble/curves/bls12-381'
import { type Hex, concatHex, hexToBigInt, hexToBytes, keccak256, numberToHex, slice, stringToHex } from 'viem'
import { describe, expect, it } from 'vitest'

/** The template a node recognises: the paymaster's 1,105-byte runtime (exp-mempool-l2s CG-10). */
const TEMPLATE = '0xec9f3f855524392a3891f2f2eb554781236d5565520d68388e455be74bdf3fe0'
const NAMESPACE = 'FRAME_TICKET_V1'
const DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_POP_'
const DENOMINATION = 10n ** 15n

const word = (n: bigint | number) => numberToHex(BigInt(n), { size: 32 })
/** EIP-8250's nonce keys hash, the word TXPARAM(0x0F) reads. */
const nonceKeysHash = (keys: bigint[]): Hex => keccak256(concatHex([word(keys.length), ...keys.map(word)]))

/** chain_id (32) || sender (20) || nonce_keys_hash (32) || nonce_seq (8) || epoch (8) || salt (32). */
const message = (chainId: number, sender: Hex, epoch: number, salt: Hex): Hex =>
  concatHex([word(chainId), sender, nonceKeysHash([0n]), numberToHex(0n, { size: 8 }), numberToHex(BigInt(epoch), { size: 8 }), salt])

const point = (m: Hex) => {
  const ns = hexToBytes(stringToHex(NAMESPACE))
  return bls.G1.hashToCurve(new Uint8Array([ns.length, ...ns, ...hexToBytes(m)]), { DST })
}

const g2FromEip2537 = (b: Hex) => {
  const c = [0, 1, 2, 3].map((i) => hexToBigInt(slice(b, 64 * i, 64 * (i + 1))))
  const p = bls.G2.ProjectivePoint.fromAffine({
    x: bls.fields.Fp2.fromBigTuple([c[0], c[1]]),
    y: bls.fields.Fp2.fromBigTuple([c[2], c[3]]),
  })
  p.assertValidity()
  return p
}

const g1Eip2537 = (compressed: Hex): Hex => {
  const { x, y } = bls.G1.ProjectivePoint.fromHex(compressed.slice(2)).toAffine()
  return concatHex([numberToHex(x, { size: 64 }), numberToHex(y, { size: 64 })])
}

/** e(signature, g2) = e(H(m), key). */
// biome-ignore lint: noble's point types
const verifies = (m: Hex, signature: Hex, key: any) =>
  bls.fields.Fp12.eql(
    bls.pairing(bls.G1.ProjectivePoint.fromHex(signature.slice(2)), bls.G2.ProjectivePoint.BASE),
    bls.pairing(point(m) as never, key),
  )

type Line = Record<string, unknown> & { event: string }
const dir = new URL('../experiments/04-x3-ticket-paid-spend/results/', import.meta.url).pathname
const runs = existsSync(dir)
  ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((file) => ({ file, r: JSON.parse(readFileSync(join(dir, file), 'utf8')) }))
  : []

for (const { file, r } of runs)
  describe(`experiment 04, ${file}`, () => {
    const sets = Object.fromEntries(r.sent.sets.map((s: { name: string }) => [s.name, s])) as Record<string, any>
    const keys = Object.fromEntries(Object.values(sets).map((s: any) => [s.name, g2FromEip2537(s.keyEip2537)]))
    const spends = r.sent.rounds.flatMap((x: { spends: unknown[] }) => x.spends) as any[]
    const [a, b] = r.nodes
    const of = (node: any, hash: string, e: string): Line[] => (node.lines[hash] as Line[]).filter((l) => l.event === e)

    it('pins every piece at a full commit, and ran both nodes with --frames.claims', () => {
      for (const pin of Object.values(r.pins) as { commit: string }[]) expect(pin.commit).toMatch(/^[0-9a-f]{40}$/)
      for (const n of r.nodes) expect(n.start.claims).toBe(true)
      expect(a.peers).toEqual([b.peerId])
      expect(b.peers).toEqual([a.peerId])
    })

    it('deployed each paymaster as the template, its set\'s key and the denomination', () => {
      for (const c of r.sent.code) {
        expect(c.bytes).toBe(1105 + 256 + 32)
        expect(c.templateHash).toBe(TEMPLATE)
        expect(c.key).toBe(sets[c.set].keyEip2537)
        expect(hexToBigInt(c.denomination)).toBe(DENOMINATION)
        expect(c.paymaster).toBe(sets[c.set].paymaster)
      }
    })

    it('refused the junk at node A with ErrClaimInvalid, before asking its client, and nothing was mined', () => {
      expect(r.sent.refused).toHaveLength(2)
      for (const x of r.sent.refused) {
        expect(x.answer.error).toContain('ErrClaimInvalid')
        const rpc = of(a, x.hash, 'rpc')
        expect(rpc).toHaveLength(1)
        expect(rpc[0].result).toBe('ErrClaimInvalid')
        expect((rpc[0].claim as { valid: boolean }).valid).toBe(false)
        expect('client' in rpc[0]).toBe(false)
        expect(of(b, x.hash, 'gossip')).toHaveLength(0)
        expect(r.chain[x.hash].mined).toBe(false)
      }
    })

    it('carries each spend\'s ticket in its mined bytes, and the ticket verifies under its own set\'s key only', () => {
      for (const s of spends) {
        expect(keccak256(s.raw)).toBe(s.hash.toLowerCase())
        expect(s.raw.toLowerCase()).toContain(concatHex([numberToHex(BigInt(s.epoch), { size: 8 }), s.salt, g1Eip2537(s.signature)]).slice(2).toLowerCase())
        const m = message(r.sent.chainId, s.sender, s.epoch, s.salt)
        expect(verifies(m, s.signature, keys[s.set])).toBe(true)
        const other = s.set === 'A' ? 'B' : 'A'
        expect(verifies(m, s.signature, keys[other])).toBe(false)
      }
    })

    it('admitted every spend at both nodes with a valid ticket, the client asked after the ticket', () => {
      for (const s of spends) {
        const rpc = of(a, s.hash, 'rpc')
        expect(rpc).toHaveLength(1)
        expect(rpc[0].result).toBe('ok')
        expect(rpc[0].client).toBe('valid')
        expect(rpc[0].claim).toEqual({ epoch: s.epoch, salt: s.salt, valid: true })
        const gossip = of(b, s.hash, 'gossip')
        expect(gossip.length).toBeGreaterThan(0)
        expect(gossip[0].from).toBe(a.peerId)
        expect(gossip[0].result).toBe('ok')
        expect((gossip[0].claim as { valid: boolean }).valid).toBe(true)
        expect(of(a, s.hash, 'handoff')).toHaveLength(0)
        expect(of(b, s.hash, 'handoff').length).toBeGreaterThan(0)
      }
    })

    it('mined every spend, paid by the paymaster of the set that issued its ticket (I6: both sets, two codebases)', () => {
      for (const s of spends) {
        const c = r.chain[s.hash]
        expect(c.mined).toBe(true)
        expect(c.status).toBe('0x1')
        expect(c.frameStatuses.every((f: string) => f === '0x1')).toBe(true)
        expect(c.payer.toLowerCase()).toBe(sets[s.set].paymaster.toLowerCase())
        expect(c.sender.toLowerCase()).toBe(s.sender.toLowerCase())
      }
      for (const name of ['A', 'B']) expect(spends.filter((s) => s.set === name).length).toBeGreaterThan(0)
    })
  })

if (runs.length === 0) it.skip('experiment 04 has no recorded run yet', () => {})
