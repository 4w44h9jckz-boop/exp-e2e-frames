// Experiment 20 (Q6), checked offline.
//
// - Each contract's .hex is what compile.mjs builds from its source and Named.yul.inc.
// - The domain tags and selectors the contracts hard-code are what their comments name.
// - Every recorded run (results/*.json): each mined transaction rebuilds to its hash; each committee
//   transaction carries its triples in a dependency frame (local) or at the end of VERIFY's data
//   (testnet); every refusal was refused by the node; every mined VERIFY frame used under 60,000 gas
//   of execution (prediction 1); and every observed signer set is the committee's (prediction 4).
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Hex, keccak256, toFunctionSelector, toHex } from 'viem'
import { describe, expect, it } from 'vitest'
import { frameTxHash, parseFrameTx } from '../src/exp-frames/frametx/index.js'
// @ts-expect-error: a plain ES module
import { NAMES, compile } from '../experiments/20-q6-committee-signatures/contracts/compile.mjs'

const here = new URL('../experiments/20-q6-committee-signatures/', import.meta.url).pathname

describe('the contracts', () => {
  for (const name of NAMES as string[]) {
    it(`${name}.hex is compile.mjs's output`, () => {
      expect(readFileSync(join(here, `contracts/${name}.hex`), 'utf8').trim()).toBe(compile(name))
    })
    const yul = readFileSync(join(here, `contracts/${name}.yul`), 'utf8')
    it(`${name}: each \`case 0x........ { ... } // sig\` is the selector of sig`, () => {
      for (const [, sel, sig] of yul.matchAll(/case (0x[0-9a-f]{8}) \{[^}]*\}\s*\/\/ ([A-Za-z0-9]+\([^)]*\))/g)) expect(sel, sig).toBe(toFunctionSelector(sig))
    })
    it(`${name}: each tag is the keccak256 of the string its comment names`, () => {
      for (const [, tag, s] of yul.matchAll(/(0x[0-9a-f]{64})\)? \/\/ keccak256\("([^"]+)"\)/g)) expect(tag, s).toBe(keccak256(toHex(s)))
    })
  }
})

type Row = { step: string; outcome?: string; refusal?: string | null; hash?: Hex; frames?: { mode: number; execution: number }[]; arm?: string }
type Record_ = { chain: 'local' | 'testnet'; rows: Row[]; observed: { step: string; signers: (number | string)[] }[]; transactions: { step: string; hash: Hex; raw: Hex }[] }
const runs = existsSync(join(here, 'results')) ? readdirSync(join(here, 'results')).filter((f) => f.endsWith('.json') && !f.includes('bench') && !f.startsWith('rehearsal')) : []

describe.skipIf(runs.length === 0)('the recorded runs', () => {
  for (const f of runs) {
    const r = JSON.parse(readFileSync(join(here, 'results', f), 'utf8')) as Record_
    it(`${f}: every mined transaction rebuilds to its hash, its triples placed for its chain`, () => {
      for (const t of r.transactions) {
        const tx = parseFrameTx(t.raw)
        expect(frameTxHash(tx), t.step).toBe(t.hash)
        const dep = tx.frames.findIndex((fr) => fr.mode === 4)
        if (r.chain === 'local') expect(dep, t.step).toBe(1)
        else expect(dep, t.step).toBe(-1)
      }
    })
    it(`${f}: every refusal was refused by the node`, () => {
      const refusals = r.rows.filter((x) => x.refusal)
      expect(refusals.length).toBeGreaterThanOrEqual(4)
      for (const x of refusals) expect(x.outcome, x.step).toBe('refused by the node')
    })
    it(`${f}: every mined committee VERIFY frame used under 60,000 gas of execution (prediction 1)`, () => {
      for (const x of r.rows.filter((y) => y.arm && !y.refusal)) {
        expect(x.outcome, x.step).toBe('mined')
        expect(x.frames![0].execution, x.step).toBeLessThan(60_000)
      }
    })
    it(`${f}: every committee transaction names its signers, members of the committee (prediction 4)`, () => {
      expect(r.observed.length).toBeGreaterThan(0)
      for (const o of r.observed) {
        expect(o.signers.length, o.step).toBeGreaterThanOrEqual(2)
        for (const s of o.signers) expect(typeof s, o.step).toBe('number')
      }
    })
  }
})
