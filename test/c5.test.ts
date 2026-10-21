// Experiment 09 (C5), every recorded run checked offline. Written before the first run, with the
// README's claim: these checks are what would show it wrong.
//
// - Identification: shown wrong if, for a box that f < t holders built, the tracer's output
//   leaves one of them out, or if any trace's output includes a holder who did not build the box.
// - On-chain proof: shown wrong if the slashing transaction fails to land, or needs more gas than
//   a block allows.
//
// Recorded either way: the queries each trace made, the evidence's bytes and gas, whether a box
// that reads the verification key evades tracing, and why a single party with t shares cannot be
// caught this way (its box gives identical answers whatever it is asked).
//
// Each named holder is checked again here as the paper's judge checks it: keccak256(w) = u_i,
// and u_i opened from the Merkle root the staking contract holds.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { type Hex, concatHex, keccak256, numberToHex } from 'viem'
import { describe, expect, it } from 'vitest'

const BN254_R = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n
const here = new URL('../experiments/09-c5-traceable-shares/', import.meta.url).pathname

const word = (n: bigint | number) => numberToHex(BigInt(n), { size: 32 })
const leaf = (i: number, u: Hex) => keccak256(concatHex([word(i), u]))
const depth = (n: number) => Math.max(1, Math.ceil(Math.log2(n)))
const root = (us: Hex[]): Hex => {
  let level: Hex[] = [...Array(2 ** depth(us.length)).keys()].map((i) => (i < us.length ? leaf(i, us[i]) : word(0)))
  while (level.length > 1) level = [...Array(level.length / 2).keys()].map((j) => keccak256(concatHex([level[2 * j], level[2 * j + 1]])))
  return level[0]
}
const opens = (i: number, u: Hex, path: Hex[], r: Hex) => {
  let node = leaf(i, u)
  path.forEach((sibling, d) => {
    node = (i >> d) & 1 ? keccak256(concatHex([sibling, node])) : keccak256(concatHex([node, sibling]))
  })
  return node === r
}
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b)
const keysIn = (v: unknown): string[] =>
  v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keysIn(x)]) : []

describe('StakeSlash.hex is its Yul compiled', () => {
  it('by solc 0.8.37, EVM osaka, optimizer on, 200 runs', () => {
    const solc = createRequire(import.meta.url)('solc') as { compile(i: string): string; version(): string }
    expect(solc.version()).toMatch(/^0\.8\.37\+/)
    const input = {
      language: 'Yul',
      sources: { a: { content: readFileSync(join(here, 'contracts/StakeSlash.yul'), 'utf8') } },
      settings: { evmVersion: 'osaka', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['evm.bytecode.object'] } } },
    }
    const out = JSON.parse(solc.compile(JSON.stringify(input)))
    const [c] = Object.values(out.contracts.a) as { evm: { bytecode: { object: string } } }[]
    expect(c.evm.bytecode.object).toBe(readFileSync(join(here, 'contracts/StakeSlash.hex'), 'utf8').trim())
  })
})

const dir = join(here, 'results')
const runs = existsSync(dir)
  ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((file) => ({ file, r: JSON.parse(readFileSync(join(dir, file), 'utf8')) }))
  : []

for (const { file, r } of runs)
  describe(`experiment 09, ${file}`, () => {
    const s = r.scheme
    const us: Hex[] = s.holders.map((h: { i: number; u: Hex }, i: number) => {
      expect(h.i).toBe(i)
      return h.u
    })

    it('pins every piece at a full commit', () => {
      for (const pin of Object.values(r.pins) as { commit: string }[]) expect(pin.commit).toMatch(/^[0-9a-f]{40}$/)
    })

    it('holds no share: no holder value y_i and no secret is recorded', () => {
      const keys = keysIn(r)
      for (const k of ['y', 'share', 'shares', 'secret', 'coefficients']) expect(keys).not.toContain(k)
    })

    it('the verification key is n hashes, and the root the contract holds is their Merkle root', () => {
      expect(us).toHaveLength(s.n)
      expect(s.t).toBeLessThanOrEqual(s.n)
      expect(root(us)).toBe(s.root)
    })

    for (const x of r.traces)
      describe(`trace ${x.label}: ${x.box}, f = ${x.f}`, () => {
        it('names no holder outside the coalition', () => {
          for (const i of x.named ?? []) expect(x.coalition, `holder ${i}`).toContain(i)
        })

        if (x.box === 'coalition' || x.box === 'noisy')
          it('names every holder in the coalition', () => {
            expect(x.coalition).toHaveLength(x.f)
            expect(x.f).toBeLessThan(s.t)
            expect(sorted(x.named ?? [])).toEqual(sorted(x.coalition))
          })

        it('records its queries: N pairs', () => {
          expect(x.queries).toBe(2 * x.N)
        })

        it("each named holder passes the paper's judge, keccak256(w) = u_i, opened from the root", () => {
          expect(sorted(x.evidence.map((e: { i: number }) => e.i))).toEqual(sorted(x.named ?? []))
          for (const e of x.evidence as { i: number; w: Hex; path: Hex[] }[]) {
            expect(BigInt(e.w)).toBeLessThan(BN254_R)
            expect(keccak256(word(BigInt(e.w)))).toBe(us[e.i])
            expect(e.path).toHaveLength(depth(s.n))
            expect(opens(e.i, us[e.i], e.path, s.root)).toBe(true)
          }
        })
      })

    it('a vk-aware box is traced, and its outcome recorded either way', () => {
      expect(r.traces.some((x: { box: string }) => x.box === 'vk-aware')).toBe(true)
    })

    it('a single party with t shares gives the tracer nothing: identical answers to every query', () => {
      const h = r.tHolder
      expect(h.named).toBeNull()
      expect(h.answers.length).toBeGreaterThan(1)
      expect(new Set(h.answers).size).toBe(1)
    })

    it('the slashing transaction was mined, within a block, and slashed exactly the named', () => {
      const c = r.chain
      const t = r.traces.find((x: { label: string }) => x.label === c.slash.trace)
      expect(t.box).toBe('coalition')
      expect(c.stake.status).toBe('0x1')
      expect(c.slash.status).toBe('0x1')
      expect(c.slash.gasUsed).toBeLessThanOrEqual(c.blockGasLimit)
      expect(sorted(c.slash.indices)).toEqual(sorted(t.named))
      expect(c.slash.bytes).toBeGreaterThan(0)
    })

    it('evidence forged against an innocent holder was refused', () => {
      const g = r.chain.forged
      expect(r.traces.flatMap((x: { coalition: number[] }) => x.coalition)).not.toContain(g.innocent)
      expect(g.accepted).toBe(false)
    })
  })
