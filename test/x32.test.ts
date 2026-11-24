// Experiment 32, checked offline: the reference keystore.
//
// - Its hashes agree with experiment 19's host: the rule digest is version 2a's key commitment,
//   and a 32-byte value's cells are lean.ts's.
// - The leaf tree's paths lead to its root, and an empty tree's root is the zero chain's top.
// - The revocation tree starts with one entry over the whole range, a rotation splits the entry
//   that brackets its key, and a revoked key has no bracketing entry.
// - The keystore refuses a repeated registration tag, a second rotation of one version, a recovery
//   executed before its delay, and an execution after a cancellation.
import { describe, expect, it } from 'vitest'
import * as L from '../experiments/19-x14-hash-based-stealth-addresses-under-8288/lean.js'
import {
  DEPTH, H, Keystore, Refused, TOP, Tree, cellsOf, entryOf, kappaOf, revTagOf, ruleDigest,
} from '../experiments/32-a-shared-keystore-for-stealth-accounts-in-leanvm/keystore.js'

const b32 = (n: number) => new Uint8Array(32).fill(n)

describe('experiment 32, the reference keystore', () => {
  it("agrees with experiment 19's host on cells and on version 2a's key commitment", () => {
    const keys = [b32(1), b32(2), b32(3)]
    expect(Buffer.from(ruleDigest(2n, keys))).toEqual(Buffer.from(L.ruleKeyOf(2n, keys)))
    expect(cellsOf(b32(7))).toEqual(L.cellsOf(b32(7)))
  })

  it('walks every path to the root', () => {
    const t = new Tree()
    for (let i = 0; i < 5; i++) t.append(b32(i + 10))
    for (let i = 0; i < 5; i++) {
      const p = t.path(i)
      let cur = t.leaf(i)
      for (let l = 0; l < DEPTH; l++) {
        const [left, right] = p.kids[l]
        expect(Buffer.from(cur)).toEqual(Buffer.from(p.bits[l] ? right : left))
        cur = H(left, right)
      }
      expect(Buffer.from(cur)).toEqual(Buffer.from(t.root()))
    }
  })

  it('splits the bracketing entry on a rotation, and a revoked key has none', () => {
    const ks = new Keystore()
    expect(ks.entries).toEqual([{ a: 0n, b: TOP, index: 0 }])
    expect(Buffer.from(ks.revoked.leaf(0))).toEqual(Buffer.from(entryOf(0n, TOP)))
    const n = revTagOf([1n, 0n], b32(9))
    const kappa = kappaOf(n)
    ks.register(b32(20), b32(21))
    ks.rotate(n, b32(22))
    expect(ks.entries.map((e) => [e.a, e.b])).toEqual([[0n, kappa], [kappa, TOP]])
    expect(ks.isRevoked(n)).toBe(true)
    expect(() => ks.rotate(n, b32(23))).toThrow(Refused)
  })

  it('refuses a repeated registration tag', () => {
    const ks = new Keystore()
    ks.register(b32(1), b32(2))
    expect(() => ks.register(b32(3), b32(2))).toThrow('registration tag already used')
  })

  it('holds a recovery for its delay, and drops it on a cancellation', () => {
    const ks = new Keystore()
    const n = revTagOf([1n, 0n], b32(4))
    ks.recover(n, b32(5))
    ks.tick(9)
    expect(() => ks.execute(n, b32(5))).toThrow('delay')
    ks.tick(1)
    ks.execute(n, b32(5))
    expect(ks.isRevoked(n)).toBe(true)
    const n2 = revTagOf([1n, 0n], b32(6))
    ks.recover(n2, b32(7))
    ks.cancel(n2, b32(7))
    ks.tick(20)
    expect(() => ks.execute(n2, b32(7))).toThrow('no such queued recovery')
  })

  it('keeps a snapshot apart from later changes', () => {
    const ks = new Keystore()
    ks.register(b32(1), b32(2))
    const before = ks.snapshot()
    ks.rotate(revTagOf([1n, 0n], b32(3)), b32(4))
    expect(Buffer.from(before.root())).not.toEqual(Buffer.from(ks.root()))
    expect(before.entries).toHaveLength(1)
  })
})
