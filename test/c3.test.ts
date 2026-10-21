// Experiment 08 (C3), every recorded run checked offline. Written before the first run, with the
// README's claim: these checks are what would show it wrong.
//
// chain, arm A: one paymaster deployed once with committee A0's key; committees A1 and A2 made by
// resharing to fresh members must hold the same key, and each committee's ticket must be admitted
// by the node, which checks it against the key in the paymaster's code, and paid by that
// paymaster. Arm B (amended before the run): a fresh DKG each epoch, each key registered with a
// paymaster of its own, each ticket admitted and paid there. Each ticket is checked again with
// noble's BLS12-381. The first committees' kept shares are recorded either way; their outcome is
// the finding (arm A's expected, before the run: they still sign).
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
    const [a, b] = r.nodes
    const of = (node: any, hash: string, e: string): Line[] => (node.lines[hash] as Line[]).filter((l) => l.event === e)
    const live = s.rounds.filter((x: { retired?: boolean }) => !x.retired)
    const retired = s.rounds.filter((x: { retired?: boolean }) => x.retired)
    const keyA = s.a.code.key as Hex
    const admittedAndPaid = (sp: any, paymaster: string) => {
      const rpc = of(a, sp.hash, 'rpc')
      expect(rpc).toHaveLength(1)
      expect(rpc[0].result).toBe('ok')
      expect(rpc[0].client).toBe('valid')
      expect((rpc[0].claim as { valid: boolean }).valid).toBe(true)
      const gossip = of(b, sp.hash, 'gossip')
      expect(gossip.length).toBeGreaterThan(0)
      expect(gossip[0].from).toBe(a.peerId)
      expect(of(b, sp.hash, 'handoff').length).toBeGreaterThan(0)
      const c = r.chain[sp.hash]
      expect(c.mined).toBe(true)
      expect(c.status).toBe('0x1')
      expect(c.frameStatuses.every((f: string) => f === '0x1')).toBe(true)
      expect(c.payer.toLowerCase()).toBe(paymaster.toLowerCase())
    }
    const ticketVerifies = (sp: any, key: Hex) =>
      verifies(message(s.chainId, sp.sender, sp.epoch, sp.salt), sp.signature, g2FromEip2537(key))
    const ticketInBytes = (sp: any) => {
      expect(keccak256(sp.raw)).toBe(sp.hash.toLowerCase())
      expect(sp.raw.toLowerCase()).toContain(
        concatHex([numberToHex(BigInt(sp.epoch), { size: 8 }), sp.salt, g1Eip2537(sp.signature)]).slice(2).toLowerCase(),
      )
    }

    it('pins every piece at a full commit, and ran both nodes with --frames.claims', () => {
      for (const pin of Object.values(r.pins) as { commit: string }[]) expect(pin.commit).toMatch(/^[0-9a-f]{40}$/)
      for (const n of r.nodes) expect(n.start.claims).toBe(true)
      expect(a.peers).toEqual([b.peerId])
      expect(b.peers).toEqual([a.peerId])
    })

    it('ran each round in its own epoch, each handoff inside the epoch it opened', () => {
      expect(live).toHaveLength(3)
      for (let i = 1; i < live.length; i++) {
        expect(live[i].epoch).toBeGreaterThan(live[i - 1].epoch)
        expect(live[i].a.handoff.secondsIntoEpoch + live[i].a.handoff.micros / 1e6).toBeLessThan(EPOCH)
        expect(live[i].b.handoff.secondsIntoEpoch + live[i].b.handoff.dkgMicros / 1e6).toBeLessThan(EPOCH)
      }
    })

    describe('arm A, reshare', () => {
      it('deployed one paymaster, the template with committee A0 key, and no other', () => {
        expect(s.a.code.bytes).toBe(1105 + 256 + 32)
        expect(s.a.code.templateHash).toBe(TEMPLATE)
        expect(hexToBigInt(s.a.code.denomination)).toBe(DENOMINATION)
        expect(keyA).toBe(s.a.committees[0].keyEip2537)
      })

      it('kept one key across three committees of fresh members: 4, then 7, then 10', () => {
        const cs = s.a.committees
        expect(cs.map((c: { members: number }) => c.members)).toEqual([4, 7, 10])
        expect(cs.map((c: { quorum: number }) => c.quorum)).toEqual([3, 5, 7])
        for (const c of cs) expect(c.keyEip2537).toBe(keyA)
        const ids = cs.map((c: { identities: string[] }) => new Set(c.identities))
        for (let i = 0; i < ids.length; i++)
          for (let j = i + 1; j < ids.length; j++) expect([...ids[i]].filter((x) => ids[j].has(x))).toEqual([])
        expect(cs.map((c: { made: { kind: string } }) => c.made.kind)).toEqual(['dkg', 'reshare', 'reshare'])
        expect(cs[1].made.dealers).toBe(cs[0].quorum)
        expect(cs[2].made.dealers).toBe(cs[1].quorum)
      })

      it('every committee ticket was issued by a quorum, verifies under the one key (noble), and was admitted and paid by the one paymaster', () => {
        for (const x of live) {
          const sp = x.a.spend
          expect(sp.answers).toHaveLength(s.a.committees[x.a.committee].quorum)
          ticketInBytes(sp)
          expect(ticketVerifies(sp, keyA)).toBe(true)
          admittedAndPaid(sp, s.a.code.paymaster)
        }
      })
    })

    describe('arm B, a fresh DKG each epoch', () => {
      it('registered each committee key with a paymaster of its own: the template, that key', () => {
        const keys = s.b.committees.map((c: { keyEip2537: string }) => c.keyEip2537)
        expect(new Set(keys).size).toBe(3)
        expect(s.b.committees.map((c: { made: { kind: string } }) => c.made.kind)).toEqual(['dkg', 'dkg', 'dkg'])
        s.b.codes.forEach((c: any, i: number) => {
          expect(c.templateHash).toBe(TEMPLATE)
          expect(c.key).toBe(keys[i])
          expect(c.paymaster.toLowerCase()).toBe(live[i].b.paymaster.toLowerCase())
        })
        for (const x of live.slice(1)) expect(BigInt(x.b.handoff.registration.gasUsed)).toBeGreaterThan(0n)
      })

      it('every committee ticket verifies under its own key only, and was admitted and paid by its own paymaster', () => {
        live.forEach((x: any, i: number) => {
          const sp = x.b.spend
          ticketInBytes(sp)
          expect(ticketVerifies(sp, s.b.committees[i].keyEip2537)).toBe(true)
          for (let j = 0; j < 3; j++) if (j !== i) expect(ticketVerifies(sp, s.b.committees[j].keyEip2537)).toBe(false)
          admittedAndPaid(sp, x.b.paymaster)
        })
      })
    })

    it('recorded what each first committee could still do with the shares it kept', () => {
      expect(retired).toHaveLength(1)
      const x = retired[0]
      expect(x.epoch).toBeGreaterThan(live[live.length - 1].epoch)
      expect(x.a.committee).toBe(0)
      expect(x.b.committee).toBe(0)
      expect(x.b.paymaster).toBe(live[live.length - 1].b.paymaster)
      for (const sp of [x.a.spend, x.b.spend]) {
        expect(typeof sp.admitted).toBe('boolean')
        expect(r.chain[sp.hash]).toBeDefined()
      }
      expect(ticketVerifies(x.a.spend, keyA)).toBe(true)
      expect(ticketVerifies(x.b.spend, s.b.committees[0].keyEip2537)).toBe(true)
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
