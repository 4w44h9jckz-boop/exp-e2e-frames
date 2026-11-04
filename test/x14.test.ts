// Experiment 19 (X14), checked offline.
//
// - The leanVM cell encoding of lean.ts matches leanVM's own known answer, H^3(5, 7).
// - Each contract hard-codes the selectors and event topics its comments name.
// - Every recorded run (test/fixtures/x14/): every frame transaction rebuilds to its hash, the
//   program keys are the programs' hashes, and each spend's VERIFY data carries a dependency of
//   its version's scheme.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Hex, keccak256, toFunctionSelector, toHex } from 'viem'
import { describe, expect, it } from 'vitest'
import { frameTxHash, parseFrameTx } from '../src/exp-frames/frametx/index.js'
import * as L from '../experiments/19-x14-hash-based-stealth-addresses-under-8288/lean.js'
import * as X from '../experiments/19-x14-hash-based-stealth-addresses-under-8288/x14.js'

const here = new URL('../experiments/19-x14-hash-based-stealth-addresses-under-8288/', import.meta.url).pathname

describe('the leanVM cell encoding', () => {
  it('reproduces H^3(5, 7) from leanVM\'s test programs', () => {
    expect(L.cellKnownAnswer()).toBe(true)
  })
})

describe('the contracts hard-code the right constants', () => {
  for (const f of ['Stealth', 'Factory', 'Pool5', 'Pool4']) {
    const yul = readFileSync(join(here, `contracts/${f}.yul`), 'utf8')
    it(`${f}: each \`case 0x........ { ... } // sig\` is the selector of sig`, () => {
      const cases = [...yul.matchAll(/case (0x[0-9a-f]{8}) \{[^}]*\}\s*\/\/ ([A-Za-z0-9]+\([^)]*\))/g)]
      expect(cases.length).toBeGreaterThan(0)
      for (const [, sel, sig] of cases) expect(sel, sig).toBe(toFunctionSelector(sig))
    })
    it(`${f}: each event topic is the keccak of the event its comment names`, () => {
      for (const [, topic, name, params] of yul.matchAll(/log\d\([^\n]*?(0x[0-9a-f]{64})[^\n]*?\)\s*\/\/ ([A-Za-z]+)\(([^)]*)\)/g)) {
        const types = params.split(',').map((p) => p.trim().split(' ')[0]).join(',')
        expect(topic, name).toBe(keccak256(toHex(`${name}(${types})`)))
      }
    })
  }
  it('Stealth and Pool5 hash the domain and zero they say they hash', () => {
    expect(readFileSync(join(here, 'contracts/Stealth.yul'), 'utf8')).toContain(X.SPEND_DOMAIN.slice(2))
    expect(readFileSync(join(here, 'contracts/Pool5.yul'), 'utf8')).toContain(keccak256(toHex('exp-e2e-frames/19/zero')).slice(2))
  })
})

const fixtures = new URL('./fixtures/x14/', import.meta.url).pathname
const runs = existsSync(fixtures) ? readdirSync(fixtures).filter((f) => f.endsWith('.json')) : []

describe.runIf(runs.length > 0)('the recorded runs rebuild', () => {
  for (const f of runs) {
    const fx = JSON.parse(readFileSync(join(fixtures, f), 'utf8'))
    it(`${f}: the program keys are the programs' hashes`, () => {
      expect(fx.vk.v1).toBe(X.VK1)
      expect(fx.vk.v5).toBe(X.VK5)
    })
    for (const t of fx.transactions as { step: string; hash: Hex; raw: Hex }[]) {
      it(`${f}: ${t.step}`, () => {
        const tx = parseFrameTx(t.raw)
        expect(frameTxHash(tx).toLowerCase()).toBe(t.hash.toLowerCase())
        const data = tx.frames[0].data
        const scheme = t.step.startsWith('v3') ? X.LEANSPHINCS_SCHEME : X.LEANSTARK_SCHEME
        const at = t.step.startsWith('v1') ? 32 : 0
        expect(BigInt(`0x${data.slice(2 + 2 * at, 2 + 2 * at + 64)}`)).toBe(scheme)
      })
    }
  }
})
