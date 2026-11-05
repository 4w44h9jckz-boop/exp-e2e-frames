// The patched builder's name for a dependency's witness, as docs/leanvm-program-layout.md section 5
// states it, checked against experiment 19's own derivation from a whole triple (local.ts's
// putWitness: keccak256 of the triple from the scheme word's last byte on).
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import * as X from '../experiments/19-x14-hash-based-stealth-addresses-under-8288/x14.js'
import { dependencyKey, LEANSTARK_SCHEME } from '../src/e2e/localchain.js'

const fromTriple = (triple: Hex) => bytesToHex(keccak_256(Buffer.from(triple.slice(2 + 62), 'hex'))).slice(2)

describe('dependencyKey', () => {
  const d = `0x${'ab'.repeat(32)}` as Hex
  it('names a leanSTARK dependency as experiment 19 did', () => {
    expect(LEANSTARK_SCHEME).toBe(Number(X.LEANSTARK_SCHEME))
    expect(dependencyKey(LEANSTARK_SCHEME, d, X.VK5)).toBe(fromTriple(X.triple(X.LEANSTARK_SCHEME, d, X.VK5)))
  })
  it('names a leanSPHINCS dependency as experiment 19 did', () => {
    const key = `0x${'cd'.repeat(32)}` as Hex
    expect(dependencyKey(0x10, d, key)).toBe(fromTriple(X.triple(X.LEANSPHINCS_SCHEME, d, key)))
  })
  it('refuses a data hash or a key that is not 32 bytes', () => {
    expect(() => dependencyKey(0x11, '0x00', X.VK5)).toThrow()
  })
})
