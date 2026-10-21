// Experiment 08 (C3), every recorded run checked offline. Written before the first run, with the
// README's claim: these checks are what would show it wrong.
//
// chain: one paymaster deployed once with committee 0's key; committees 1 and 2 made by
// resharing to fresh members must hold the same key, and each committee's ticket must be admitted
// by the node, which checks it against the key in the paymaster's code, and paid by that
// paymaster. Each ticket is checked again with noble's BLS12-381. The retired committee's ticket
// is recorded either way; its outcome is the finding, not a check.
//
// measure: every reshare keeps the key; every byte sent is received; and a member's reshare
// takes less than an epoch at the committee sizes the posts name (3-of-5, 7-of-10, 13 nodes, 256
// seats), with the network's time added at three one-way trips.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { bls12_381 as bls } from '@noble/curves/bls12-381'
import { type Hex, concatHex, hexToBigInt, hexToBytes, keccak256, numberToHex, slice, stringToHex } from 'viem'
import { describe, expect, it } from 'vitest'

const TEMPLATE = '0xec9f3f855524392a3891f2f2eb554781236d5565520d68388e455be74bdf3fe0'
const NAMESPACE = 'FRAME_TICKET_V1'
const DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_POP_'
const DENOMINATION = 10n ** 15n
const EPOCH = 384
/** The committee sizes the posts name. */
const NAMED_SIZES = [5, 10, 13, 256]
/** One-way latency allowed per round when a member's time is set against an epoch: a WAN trip. */
const WAN_ONE_WAY_MS = 150

const word = (n: bigint | number) => numberToHex(BigInt(n), { size: 32 })
const nonceKeysHash = (keys: bigint[]): Hex => keccak256(concatHex([word(keys.length), ...keys.map(word)]))
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
// biome-ignore lint: noble's point types
const verifies = (m: Hex, signature: Hex, key: any) =>
  bls.fields.Fp12.eql(
    bls.pairing(bls.G1.ProjectivePoint.fromHex(signature.slice(2)), bls.G2.ProjectivePoint.BASE),
    bls.pairing(point(m) as never, key),
  )

type Line = Record<string, unknown> & { event: string }
const dir = new URL('../experiments/08-c3-epoch-reshare/results/', import.meta.url).pathname
const runs = (prefix: string) =>
  existsSync(dir)
    ? readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).map((file) => ({ file, r: JSON.parse(readFileSync(join(dir, file), 'utf8')) }))
    : []

for (const { file, r } of runs('chain-'))
  describe(`experiment 08, ${file}`, () => {
    const s = r.sent
    const key = s.code.key as Hex
    const [a, b] = r.nodes
    const of = (node: any, hash: string, e: string): Line[] => (node.lines[hash] as Line[]).filter((l) => l.event === e)
    const live = s.rounds.filter((x: { retired?: boolean }) => !x.retired)

    it('pins every piece at a full commit, and ran both nodes with --frames.claims', () => {
      for (const pin of Object.values(r.pins) as { commit: string }[]) expect(pin.commit).toMatch(/^[0-9a-f]{40}$/)
      for (const n of r.nodes) expect(n.start.claims).toBe(true)
      expect(a.peers).toEqual([b.peerId])
      expect(b.peers).toEqual([a.peerId])
    })

    it('deployed one paymaster, the template with committee 0 key, and no other', () => {
      expect(s.code.bytes).toBe(1105 + 256 + 32)
      expect(s.code.templateHash).toBe(TEMPLATE)
      expect(hexToBigInt(s.code.denomination)).toBe(DENOMINATION)
      expect(key).toBe(s.committees[0].keyEip2537)
      for (const x of s.rounds) expect(x.spend.payer.toLowerCase()).toBe(s.code.paymaster.toLowerCase())
    })

    it('kept one key across three committees of fresh members: 4, then 7, then 10', () => {
      expect(s.committees.map((c: { members: number }) => c.members)).toEqual([4, 7, 10])
      expect(s.committees.map((c: { quorum: number }) => c.quorum)).toEqual([3, 5, 7])
      for (const c of s.committees) expect(c.keyEip2537).toBe(key)
      const ids = s.committees.map((c: { identities: string[] }) => new Set(c.identities))
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++) expect([...ids[i]].filter((x) => ids[j].has(x))).toEqual([])
      expect(s.committees[0].made.kind).toBe('dkg')
      expect(s.committees[1].made.kind).toBe('reshare')
      expect(s.committees[2].made.kind).toBe('reshare')
      expect(s.committees[1].made.dealers).toBe(s.committees[0].quorum)
      expect(s.committees[2].made.dealers).toBe(s.committees[1].quorum)
    })

    it('ran each committee in its own epoch, each handoff inside the epoch it opened', () => {
      expect(live.map((x: { committee: number }) => x.committee)).toEqual([0, 1, 2])
      for (let i = 1; i < live.length; i++) {
        expect(live[i].epoch).toBeGreaterThan(live[i - 1].epoch)
        expect(live[i].handoff.secondsIntoEpoch + live[i].handoff.micros / 1e6).toBeLessThan(EPOCH)
      }
    })

    it('issued every ticket from a quorum of its committee, and it verifies under the one key (noble)', () => {
      for (const x of s.rounds) {
        const c = s.committees[x.committee]
        expect(x.spend.answers).toHaveLength(c.quorum)
        expect(new Set(x.spend.answers.map((q: { index: number }) => q.index)).size).toBe(c.quorum)
        expect(keccak256(x.spend.raw)).toBe(x.spend.hash.toLowerCase())
        expect(x.spend.raw.toLowerCase()).toContain(
          concatHex([numberToHex(BigInt(x.spend.epoch), { size: 8 }), x.spend.salt, g1Eip2537(x.spend.signature)]).slice(2).toLowerCase(),
        )
        expect(verifies(message(s.chainId, x.spend.sender, x.spend.epoch, x.spend.salt), x.spend.signature, g2FromEip2537(key))).toBe(true)
      }
    })

    it('admitted every live committee spend at both nodes, the ticket checked first, and the chain paid it from the one paymaster', () => {
      for (const x of live) {
        const h = x.spend.hash
        const rpc = of(a, h, 'rpc')
        expect(rpc).toHaveLength(1)
        expect(rpc[0].result).toBe('ok')
        expect(rpc[0].client).toBe('valid')
        expect((rpc[0].claim as { valid: boolean }).valid).toBe(true)
        const gossip = of(b, h, 'gossip')
        expect(gossip.length).toBeGreaterThan(0)
        expect(gossip[0].from).toBe(a.peerId)
        expect(of(b, h, 'handoff').length).toBeGreaterThan(0)
        const c = r.chain[h]
        expect(c.mined).toBe(true)
        expect(c.status).toBe('0x1')
        expect(c.frameStatuses.every((f: string) => f === '0x1')).toBe(true)
        expect(c.payer.toLowerCase()).toBe(s.code.paymaster.toLowerCase())
      }
    })

    it('recorded what the retired committee could still do, with the chain facts', () => {
      const retired = s.rounds.filter((x: { retired?: boolean }) => x.retired)
      expect(retired).toHaveLength(1)
      expect(retired[0].committee).toBe(0)
      expect(retired[0].epoch).toBeGreaterThan(live[live.length - 1].epoch)
      expect(r.chain[retired[0].spend.hash]).toBeDefined()
    })
  })

for (const { file, r } of runs('measure-'))
  describe(`experiment 08, ${file}`, () => {
    const m = r.measured
    const memberMs = (round: { participants: { computeMicros: number }[] }) =>
      Math.max(...round.participants.map((p) => p.computeMicros)) / 1000

    it('says what network its times assume', () => {
      expect(m.network).toMatch(/one process/)
      expect(m.epochSeconds).toBe(EPOCH)
    })

    it('kept the key in every reshare, and every byte sent was received', () => {
      for (const x of m.sizes) {
        expect(x.keyUnchanged).toBe(true)
        for (const round of [x.dkg, x.reshare]) {
          const sum = (k: string) => round.participants.reduce((acc: number, p: Record<string, number>) => acc + p[k], 0)
          expect(sum('bytesSent')).toBe(sum('bytesReceived'))
          expect(sum('messagesSent')).toBe(sum('messagesReceived'))
          for (const p of round.participants) expect(p.rounds).toBe(3)
        }
        expect(x.reshare.players).toBe(x.n)
        expect(x.reshare.dealers).toBe(x.dkg.quorum)
      }
    })

    it('a member reshares within an epoch at every committee size the posts name', () => {
      for (const n of NAMED_SIZES) {
        const x = m.sizes.find((y: { n: number }) => y.n === n)
        expect(x, `size ${n} measured`).toBeDefined()
        expect(memberMs(x.reshare) + 3 * WAN_ONE_WAY_MS, `size ${n}`).toBeLessThan(EPOCH * 1000)
      }
    })
  })
