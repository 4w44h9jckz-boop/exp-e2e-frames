// Experiment 15 (X10), checked offline.
//
// - Every selector and event topic Registry.yul hard-codes is the keccak of the signature its
//   comment names.
// - Every frame transaction a registry sent in a recorded run (test/fixtures/x10/) rebuilds to its
//   hash, has the layout the registry's VERIFY requires, and carries a proof that verifies against
//   the circuit's key with the public inputs the registry passes, recomputed from the frames: the
//   root from the EIP-8272 frame, the binding from the words it covers.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Hex, concatHex, decodeFunctionData, hexToBigInt, keccak256, numberToHex, toFunctionSelector, toHex } from 'viem'
import { describe, expect, it } from 'vitest'
import { Mode, frameTxHash, parseFrameTx } from '../src/exp-frames/frametx/index.js'

const here = new URL('../experiments/15-x10-out-and-back/', import.meta.url).pathname
const source = readFileSync(join(here, 'contracts/Registry.yul'), 'utf8')
const word = (x: bigint) => numberToHex(x, { size: 32 })
const bindingOf = (ws: bigint[]) => hexToBigInt(keccak256(concatHex(ws.map(word)))) >> 8n
const ETH_TAG = 0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeen

describe('Registry.yul hard-codes the right selectors and topics', () => {
  it('each `case 0x........ { ... } // sig` is the selector of sig', () => {
    const cases = [...source.matchAll(/case (0x[0-9a-f]{8}) \{[^}]*\}\s*\/\/ ([A-Za-z]+\([^)]*\))/g)]
    expect(cases.length).toBeGreaterThan(10)
    for (const [, sel, sig] of cases) expect(sel, sig).toBe(toFunctionSelector(sig))
  })
  it('each event topic is the keccak of the event its comment names', () => {
    const logs = [...source.matchAll(/log\d\([^)]*?(0x[0-9a-f]{64})[^)]*\)(?:\s*\/\/ ([A-Za-z]+)\(([^)]*)\))?/g)]
    const named = logs.filter((m) => m[2])
    expect(named.length).toBeGreaterThan(4)
    for (const [, topic, name, params] of named) {
      const types = params.split(',').map((p) => p.trim().split(' ')[0]).join(',')
      expect(topic, name).toBe(keccak256(toHex(`${name}(${types})`)))
    }
  })
})

const fixtures = new URL('./fixtures/x10/', import.meta.url).pathname
const runs = existsSync(fixtures) ? readdirSync(fixtures).filter((f) => f.endsWith('.json')) : []

describe.runIf(runs.length > 0)('the recorded runs rebuild and their proofs verify', async () => {
  const snarkjs = (await import('snarkjs')) as unknown as { groth16: { verify(vk: unknown, inputs: string[], proof: unknown): Promise<boolean> } }
  const vk = (c: string) => JSON.parse(readFileSync(join(here, `build/${c}.vkey.json`), 'utf8'))
  const verify = (c: string, proof: bigint[], inputs: bigint[]) => {
    const p = proof.map(String)
    return snarkjs.groth16.verify(vk(c), inputs.map(String), { protocol: 'groth16', curve: 'bn128', pi_a: [p[0], p[1], '1'], pi_b: [[p[3], p[2]], [p[5], p[4]], ['1', '0']], pi_c: [p[6], p[7], '1'] })
  }
  const abi = [
    { type: 'function', name: 'processPrivateTransaction', inputs: [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256[]' }], outputs: [], stateMutability: 'nonpayable' },
    { type: 'function', name: 'advanceRoot', inputs: [{ type: 'uint256[]' }], outputs: [], stateMutability: 'nonpayable' },
  ] as const
  for (const f of runs) {
    const fx = JSON.parse(readFileSync(join(fixtures, f), 'utf8')) as { contracts: Record<string, string>; transactions: { step: string; hash: Hex; raw: Hex }[] }
    const registries = [fx.contracts['registry/tree'], fx.contracts['registry/append']].map((a) => a.toLowerCase())
    for (const t of fx.transactions) {
      it(`${f}: ${t.step}`, async () => {
        const tx = parseFrameTx(t.raw)
        expect(frameTxHash(tx).toLowerCase()).toBe(t.hash.toLowerCase())
        expect(registries).toContain(tx.sender.toLowerCase())
        expect(tx.signatures).toHaveLength(0)
        expect(tx.nonceSeq).toBe(0n)
        const sender = tx.frames.at(-1)!
        expect(sender.mode).toBe(Mode.SENDER)
        const call = decodeFunctionData({ abi, data: sender.data })
        if (call.functionName === 'advanceRoot') {
          const w = call.args[0] as bigint[]
          expect(tx.nonceKeys).toEqual([(1n << 255n) | w[0]])
          // The old root is the registry's at the time; the proof binds it, so check that the
          // proof verifies for some old root by recomputing it is not possible offline: the
          // fixture's next batch or spend proves against the new one. Here: the new root, the
          // index and the leaves are what the proof is for, against the root the previous batch
          // left (or the empty tree's).
          return
        }
        const [rootHex, kind, w] = call.args as [Hex, bigint, bigint[]]
        const root = hexToBigInt(rootHex)
        if (kind === 1n) {
          expect(tx.frames[0].data.slice(-64)).toBe(rootHex.slice(2))
          expect(tx.nonceKeys).toEqual([w[0]])
          const inputs = [root, w[0], w[1], w[2], w[3], w[4], bindingOf(w.slice(5, 11))]
          expect(await verify('kernel', w.slice(11, 19), inputs)).toBe(true)
        } else if (kind === 3n) {
          expect(tx.frames[0].data.slice(-64)).toBe(rootHex.slice(2))
          expect(tx.nonceKeys).toEqual(w.slice(0, 4))
          expect(w[12]).toBe(ETH_TAG)
          const inputs = [root, w[13], w[12], ...w.slice(0, 12), bindingOf(w.slice(14, 18))]
          expect(await verify('round4', w.slice(18, 26), inputs)).toBe(true)
        } else if (kind === 2n) {
          expect(tx.nonceKeys).toEqual([w[0]])
          const id = hexToBigInt(keccak256(concatHex([word(w[1]), word(w[3]), word(w[2])])))
          expect(w[0]).toBe(id)
          expect(await verify('import', w.slice(5, 13), [w[1], w[2], w[3], w[4]])).toBe(true)
        } else {
          throw new Error(`kind ${kind}`)
        }
      })
    }
    it(`${f}: every batch proof verifies against the root the batch before it left`, async () => {
      let oldRoot = 0x29d7ed391256ccc3ea596c86e933b89ff339d25ea8ddced975ae2fe30b5296d4n
      for (const t of fx.transactions) {
        const tx = parseFrameTx(t.raw)
        const call = decodeFunctionData({ abi, data: tx.frames.at(-1)!.data })
        if (call.functionName !== 'advanceRoot') continue
        const w = call.args[0] as bigint[]
        expect(await verify('batch8', w.slice(10, 18), [oldRoot, w[1], w[0], ...w.slice(2, 10)])).toBe(true)
        oldRoot = w[1]
      }
    })
  }
})
