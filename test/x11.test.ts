// Experiment 16 (X11), checked offline.
//
// - Every selector, event topic and digest tag ReadPool.yul hard-codes is the keccak of what its
//   comment names.
// - Every frame transaction the pool sent in a recorded run (test/fixtures/x11/) rebuilds to its
//   hash, has the layout ReadPool's VERIFY requires, and carries three signatures over the digest
//   its words describe, each recovering to the member it names; a slash's two signatures recover
//   to its member and its serial's paths lead to the roots signed.
// - Every ticket in the record is the issuers' BLS signature for its server and serial.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Address, type Hex, decodeFunctionData, getAddress, keccak256, numberToHex, recoverAddress, toFunctionSelector, toHex } from 'viem'
import { describe, expect, it } from 'vitest'
import { Mode, frameTxHash, parseFrameTx } from '../src/exp-frames/frametx/index.js'
import { verifyTicket } from '../experiments/16-x11-paid-reads-settled/tickets.js'
import * as X from '../experiments/16-x11-paid-reads-settled/x11.js'

const here = new URL('../experiments/16-x11-paid-reads-settled/', import.meta.url).pathname
const source = readFileSync(join(here, 'contracts/ReadPool.yul'), 'utf8')
const word = (x: bigint) => numberToHex(x, { size: 32 })
const addr = (x: bigint): Address => getAddress(numberToHex(x, { size: 20 }))

describe('ReadPool.yul hard-codes the right selectors, topics and tags', () => {
  it('each `case 0x........ { ... } // sig` is the selector of sig', () => {
    const cases = [...source.matchAll(/case (0x[0-9a-f]{8}) \{[^}]*\}\s*\/\/ ([A-Za-z]+\([^)]*\))/g)]
    expect(cases.length).toBeGreaterThan(10)
    for (const [, sel, sig] of cases) expect(sel, sig).toBe(toFunctionSelector(sig))
  })
  it('each event topic is the keccak of the event its comment names', () => {
    // One line each; a log's arguments may hold calls, so read to the comment at the line's end.
    const logs = [...source.matchAll(/log\d\([^\n]*?(0x[0-9a-f]{64})[^\n]*?\)\s*\/\/ ([A-Za-z]+)\(([^)]*)\)/g)]
    expect(logs.length).toBe(5)
    for (const [, topic, name, params] of logs) {
      const types = params.split(',').map((p) => p.trim().split(' ')[0]).join(',')
      expect(topic, name).toBe(keccak256(toHex(`${name}(${types})`)))
    }
  })
  it('the digest tags are the keccak of their strings', () => {
    for (const [, tag, s] of source.matchAll(/mstore\(0x100, (0x[0-9a-f]{64})\) \/\/ keccak256\("([^"]+)"\)/g)) expect(tag).toBe(keccak256(toHex(s)))
    expect(X.SETTLE_TAG).toBe(keccak256(toHex('exp-e2e-frames/16/settle')))
  })
})

const fixtures = new URL('./fixtures/x11/', import.meta.url).pathname
const runs = existsSync(fixtures) ? readdirSync(fixtures).filter((f) => f.endsWith('.json')) : []
const abi = X.poolAbi

describe.runIf(runs.length > 0)('the recorded runs rebuild and their signatures recover', () => {
  for (const f of runs) {
    const fx = JSON.parse(readFileSync(join(fixtures, f), 'utf8')) as { pool: Address; members: Address[]; chainId: number; key: Hex; tickets: { server: Address; serial: Hex; ticket: Hex }[]; transactions: { step: string; hash: Hex; raw: Hex }[] }
    const chainId = BigInt(fx.chainId)
    const signer = (digest: Hex, r: bigint, s: bigint, v: bigint) => recoverAddress({ hash: digest, signature: { r: word(r), s: word(s), v } })
    for (const t of fx.transactions) {
      it(`${f}: ${t.step}`, async () => {
        const tx = parseFrameTx(t.raw)
        expect(frameTxHash(tx).toLowerCase()).toBe(t.hash.toLowerCase())
        expect(tx.sender.toLowerCase()).toBe(fx.pool.toLowerCase())
        expect(tx.frames).toHaveLength(2)
        expect(tx.frames[0].mode).toBe(Mode.VERIFY)
        expect(tx.frames[0].limits.execution).toBeLessThanOrEqual(X.VERIFY_LIMIT)
        expect(tx.frames[1].mode).toBe(Mode.SENDER)
        expect(tx.signatures).toHaveLength(0)
        const call = decodeFunctionData({ abi, data: tx.frames[1].data })
        const w = (call.args as [bigint[]])[0]
        if (call.functionName === 'settle') {
          expect(tx.nonceKeys).toEqual([X.keyFor(1n, w[0], w[1])])
          const digest = X.settleDigest(chainId, fx.pool, addr(w[0]), w[1], w[2], word(w[3]))
          for (let j = 0; j < 3; j++) expect(await signer(digest, w[6 + 4 * j], w[7 + 4 * j], w[8 + 4 * j])).toBe(fx.members[Number(w[5 + 4 * j])])
        } else if (call.functionName === 'refund') {
          expect(tx.nonceKeys).toEqual([X.keyFor(2n, w[0], 0n)])
          const digest = X.refundDigest(chainId, fx.pool, word(w[0]), addr(w[1]))
          for (let j = 0; j < 3; j++) expect(await signer(digest, w[4 + 4 * j], w[5 + 4 * j], w[6 + 4 * j])).toBe(fx.members[Number(w[3 + 4 * j])])
        } else if (call.functionName === 'slash') {
          expect(tx.nonceKeys).toEqual([X.slashKey(chainId, fx.pool, w)])
          const m = fx.members[Number(w[0])]
          const a = X.settleDigest(chainId, fx.pool, addr(w[4]), w[5], w[6], word(w[7]))
          expect(await signer(a, w[8], w[9], w[10])).toBe(m)
          if (w[3] === 1n) {
            const b = X.settleDigest(chainId, fx.pool, addr(w[11]), w[12], w[13], word(w[14]))
            expect(a).not.toBe(b)
            expect(await signer(b, w[15], w[16], w[17])).toBe(m)
          } else {
            expect(await signer(X.refundDigest(chainId, fx.pool, word(w[11]), addr(w[12])), w[13], w[14], w[15])).toBe(m)
          }
        } else {
          throw new Error(call.functionName)
        }
      })
    }
    // About 40 ms a ticket: well over vitest's default timeout for a run's few hundred.
    it(`${f}: every ticket is the issuers' signature for its server and serial`, () => {
      for (const t of fx.tickets) expect(verifyTicket(fx.key, t.server, t.serial, t.ticket)).toBe(true)
    }, 120_000)
  }
})
