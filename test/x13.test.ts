// Experiment 18 (X13), checked offline.
//
// - Registry18.yul hard-codes the right selectors and event topics.
// - FMD2 detects its own flags and refuses others' at about its rate, on a small sample.
// - The note's encodings: first contact and pairwise sealing open to the opening they sealed, and
//   a changed byte opens to nothing.
// - Every recorded run (test/fixtures/x13/): every spend rebuilds to its hash, is sent by the
//   registry with the nullifier as its one nonce key at sequence 0, and carries a proof the
//   verification key accepts; and both blobs the run posted rebuild to their versioned hashes.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import * as snarkjs from 'snarkjs'
import { type Hex, decodeFunctionData, hexToBytes, keccak256, toFunctionSelector, toHex } from 'viem'
import { describe, expect, it } from 'vitest'
import { Mode, frameTxHash, parseFrameTx } from '../src/exp-frames/frametx/index.js'
import * as B from '../experiments/17-x12-ciphertexts-in-blobs/blob.js'
import * as F from '../experiments/18-x13-out-of-band-delivery/fmd.js'
import * as N from '../experiments/18-x13-out-of-band-delivery/notes.js'
import * as X from '../experiments/18-x13-out-of-band-delivery/x13.js'

const here = new URL('../experiments/18-x13-out-of-band-delivery/', import.meta.url).pathname
const yul = readFileSync(join(here, 'contracts/Registry18.yul'), 'utf8')
const rnd = () => crypto.getRandomValues(new Uint8Array(32))

describe('Registry18.yul hard-codes the right constants', () => {
  it('each `case 0x........ { ... } // sig` is the selector of sig', () => {
    const cases = [...yul.matchAll(/case (0x[0-9a-f]{8}) \{[^}]*\}\s*\/\/ ([A-Za-z]+\([^)]*\))/g)]
    expect(cases.length).toBe(7)
    for (const [, sel, sig] of cases) expect(sel, sig).toBe(toFunctionSelector(sig))
  })
  it('each event topic is the keccak of the event its comment names', () => {
    const logs = [...yul.matchAll(/log\d\([^\n]*?(0x[0-9a-f]{64})[^\n]*?\)\s*\/\/ ([A-Za-z]+)\(([^)]*)\)/g)]
    expect(logs.length).toBe(2)
    for (const [, topic, name, params] of logs) {
      const types = params.split(',').map((p) => p.trim().split(' ')[0]).join(',')
      expect(topic, name).toBe(keccak256(toHex(`${name}(${types})`)))
    }
  })
  it('VERIFY expects deliver(uint256[]) and twelve words', () => {
    expect(yul).toContain(`eq(shr(224, framedataload(0, 1)), ${toFunctionSelector('deliver(uint256[])')})`)
    expect(yul).toContain('eq(framedataload(0x24, 1), 12)')
  })
})

describe('FMD2', () => {
  it('flags its own messages, and others\' at about the rate', () => {
    const me = F.keygen(rnd)
    const other = F.keygen(rnd)
    const d = F.extract(me.sk, 2)
    for (let i = 0; i < 5; i++) expect(F.test(d, F.flagFrom(F.flagBytes(F.flag(me.pk, rnd))))).toBe(true)
    const hits = Array.from({ length: 200 }, () => F.test(d, F.flag(other.pk, rnd))).filter(Boolean).length
    expect(hits).toBeGreaterThan(20)
    expect(hits).toBeLessThan(85)
  }, 120_000)
})

describe('the note\'s encodings', () => {
  const o: N.Opening = { value: N.DENOM, n: 5n, s: 6n, T: 1_800_000_000n, refund: 7n }
  it('first contact seals 1,241 bytes that open to the opening', () => {
    const k = N.kemKeygen(new Uint8Array(64).fill(3))
    const { entry, ss } = N.sealFirst(k.ek, o, new Uint8Array(32).fill(4))
    expect(entry).toHaveLength(N.ENTRY_BYTES)
    const opened = N.openFirst(k.dk, entry)!
    expect(opened.opening).toEqual(o)
    expect(Buffer.from(opened.ss).equals(Buffer.from(ss))).toBe(true)
    const changed = entry.slice()
    changed[1100] ^= 1
    expect(N.openFirst(k.dk, changed)).toBeUndefined()
  })
  it('a pairwise note is 152 bytes under its own tag', () => {
    const ss = new Uint8Array(32).fill(9)
    const sealed = N.sealPair(ss, 1, o)
    expect(sealed).toHaveLength(152)
    expect(N.openPair(ss, 1, sealed)).toEqual(o)
    expect(N.openPair(ss, 2, sealed)).toBeUndefined()
    expect(Buffer.from(N.pairTag(ss, 1)).equals(Buffer.from(N.pairTag(ss, 2)))).toBe(false)
  })
})

const fixtures = new URL('./fixtures/x13/', import.meta.url).pathname
const runs = existsSync(fixtures) ? readdirSync(fixtures).filter((f) => f.endsWith('.json')) : []

describe.runIf(runs.length > 0)('the recorded runs rebuild', () => {
  for (const f of runs) {
    const fx = JSON.parse(readFileSync(join(fixtures, f), 'utf8'))
    for (const t of fx.transactions as { step: string; hash: Hex; raw: Hex }[]) {
      it(`${f}: ${t.step}`, async () => {
        const tx = parseFrameTx(t.raw)
        expect(frameTxHash(tx).toLowerCase()).toBe(t.hash.toLowerCase())
        expect(tx.sender.toLowerCase()).toBe(fx.registry.toLowerCase())
        expect(tx.frames.map((fr) => fr.mode)).toEqual([Mode.VERIFY, Mode.SENDER])
        const w = (decodeFunctionData({ abi: X.registryAbi, data: tx.frames[1].data }).args as [bigint[]])[0]
        expect(w).toHaveLength(12)
        expect(tx.nonceKeys).toEqual([w[1]])
        expect(tx.nonceSeq).toBe(0n)
        const p = w.slice(4).map(String)
        const proof = { protocol: 'groth16', curve: 'bn128', pi_a: [p[0], p[1], '1'], pi_b: [[p[3], p[2]], [p[5], p[4]], ['1', '0']], pi_c: [p[6], p[7], '1'] }
        expect(await snarkjs.groth16.verify(X.VKEY, w.slice(0, 4).map(String), proof)).toBe(true)
      }, 60_000)
    }
    it(`${f}: both blobs rebuild to their versioned hashes, each holding its note`, () => {
      for (const [k, label] of [['arm3', '3-blob'], ['arm6', '6-late']] as const) {
        const entries = (fx.blobs[k].entries as Hex[]).map((e) => hexToBytes(e))
        expect(B.versionedHashOf(B.commitmentOf(B.packBlob(B.KIND.N, entries)))).toBe(fx.blobs[k].vh)
        const note = fx.notes.find((n: { label: string }) => n.label === label)
        expect(entries.some((e) => Buffer.from(e).equals(Buffer.from(hexToBytes(note.delivered))))).toBe(true)
      }
    })
    it(`${f}: every note's h is the hash of the bytes delivered for it`, () => {
      for (const n of fx.notes as { h: Hex; delivered: Hex }[]) expect(BigInt(n.h)).toBe(N.hOf(hexToBytes(n.delivered)))
    })
  }
})
