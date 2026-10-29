// The gas-by-function measurement, checked offline.
//
// - Topics of the three commonest events are the published constants, so the hashing is right.
// - No signature sits in two classes, and the first matching class wins.
// - The precompile walk counts nested calls and only precompile addresses.
// - Every committed result adds up: its classes sum to its transactions and its gas.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLASSES, EVENTS, TOPICS, classify, precompileGas } from '../measurements/gas-by-function/classes.js'

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const SWAP_V2 = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'
const SWAP_V3 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'

describe('event signatures', () => {
  it('hash to the published topics', () => {
    expect(TOPICS['token-move'].get(TRANSFER)).toBe('Transfer(address,address,uint256)')
    expect(TOPICS.trade.get(SWAP_V2)).toBe('Swap(address,uint256,uint256,uint256,uint256,address)')
    expect(TOPICS.trade.get(SWAP_V3)).toBe('Swap(address,address,int256,int256,uint160,uint128,int24)')
  })
  it('appear in one class each', () => {
    const all = Object.values(EVENTS).flat()
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('classify', () => {
  const call = { type: '0x2', to: '0x00000000000000000000000000000000000000aa', input: '0x12345678' }
  const ok = (topics: string[][]) => ({ status: '0x1', logs: topics.map((t) => ({ topics: t })) })
  it('takes the first class that matches, in order', () => {
    const hits = new Map<string, number>()
    expect(classify(call, ok([[TRANSFER], [SWAP_V3], [TRANSFER]]), hits)).toBe('trade')
    expect(hits.get('Swap(address,address,int256,int256,uint160,uint128,int24)')).toBe(1)
    expect(hits.has('Transfer(address,address,uint256)')).toBe(false)
    expect(classify(call, ok([[TRANSFER]]), hits)).toBe('token-move')
    expect(classify(call, { status: '0x0', logs: [] }, hits)).toBe('reverted')
    expect(classify({ ...call, type: '0x3' }, ok([[SWAP_V2]]), hits)).toBe('blob-carrier')
  })
  it('falls back on the transaction when no event is known', () => {
    const hits = new Map<string, number>()
    expect(classify({ ...call, input: '0x' }, ok([]), hits)).toBe('eth-transfer')
    expect(classify({ ...call, to: null }, ok([]), hits)).toBe('create')
    expect(classify(call, ok([['0x' + '11'.repeat(32)], []]), hits)).toBe('other-call')
  })
})

describe('precompileGas', () => {
  it('counts nested precompile calls and nothing else', () => {
    const out = new Map<string, number>()
    precompileGas({
      to: '0x00000000000000000000000000000000000000aa', gasUsed: '0x5208', calls: [
        { to: '0x0000000000000000000000000000000000000008', gasUsed: '0x1b968' },
        { to: '0x00000000000000000000000000000000000000bb', calls: [{ to: '0x0000000000000000000000000000000000000001', gasUsed: '0xbb8' }] },
        { to: '0x0000000000000000000000000000000000000100', gasUsed: '0xd48' },
        { to: '0x0000000000000000000000000000000000000101', gasUsed: '0x64' },
      ],
    }, out)
    expect(Object.fromEntries(out)).toEqual({ 'bn254-pairing': 113000, ecrecover: 3000, p256verify: 3400 })
  })
})

const results = new URL('../measurements/gas-by-function/results/', import.meta.url).pathname
const files = existsSync(results) ? readdirSync(results).filter((f) => f.endsWith('.json')) : []

describe.runIf(files.length > 0)('the committed results add up', () => {
  for (const f of files) {
    it(f, () => {
      const r = JSON.parse(readFileSync(join(results, f), 'utf8'))
      const classes = Object.values(r.by_class) as { txs: number; gas: number }[]
      expect(Object.keys(r.by_class)).toEqual(CLASSES)
      expect(classes.reduce((a, c) => a + c.txs, 0)).toBe(r.transactions)
      expect(classes.reduce((a, c) => a + c.gas, 0)).toBe(r.execution_gas)
      expect(r.blocks.length).toBe(r.blocks_read)
      expect(r.blocks.reduce((a: number, b: { gas_used: number }) => a + b.gas_used, 0)).toBe(r.execution_gas)
    })
  }
})
