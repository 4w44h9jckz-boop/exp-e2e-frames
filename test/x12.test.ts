// Experiment 17 (X12), checked offline.
//
// - ERC-8441 schemeId 3 as implemented here reproduces the scheme's vectors V3-06, V3-09, V3-16
//   and V3-17.
// - Board.yul hard-codes the right selectors, topics, digest tag, root of unity and modulus.
// - Every recorded run (test/fixtures/x12/): its two blobs rebuild from their entries to the
//   versioned hashes the Board recorded; every Board post rebuilds to its hash, carries that one
//   blob, is signed by the packer, and opens at z = 1 to its header; archiver A's answer opens at
//   its challenge's point; and our recipient's entries are where the run put them.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1'
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js'
import { type Hex, bytesToHex, decodeFunctionData, hexToBytes, keccak256, numberToHex, recoverAddress, toFunctionSelector, toHex } from 'viem'
import { describe, expect, it } from 'vitest'
import { Mode, frameTxHash, parseFrameTx } from '../src/exp-frames/frametx/index.js'
import * as B from '../experiments/17-x12-ciphertexts-in-blobs/blob.js'
import * as P from '../experiments/17-x12-ciphertexts-in-blobs/payloads.js'
import * as X from '../experiments/17-x12-ciphertexts-in-blobs/x12.js'

const here = new URL('../experiments/17-x12-ciphertexts-in-blobs/', import.meta.url).pathname
const V = JSON.parse(readFileSync(join(here, 'vectors/erc8441.json'), 'utf8'))
const h = (s: string) => hexToBytes(`0x${s}`)
const hex = (b: Uint8Array) => bytesToHex(b).slice(2)

describe('ERC-8441 schemeId 3 reproduces the scheme\'s vectors', () => {
  it('V3-09: keygen', () => {
    const v = V['V3-09']
    const { recipient, master } = P.keygen(h(v.given.keygen_seed))
    expect(hex(recipient.meta)).toBe(v.expect.meta_address)
    expect(hex(master)).toBe(v.expect.master)
  })
  it('V3-06: the combiner, from esk and Encaps_internal(ek, m)', () => {
    const v = V['V3-06']
    const p = v.given.parts
    expect(hex(secp256k1.getPublicKey(h(v.given.esk), true))).toBe(p.epk)
    expect(hex(P.ecdhX(h(v.given.esk), h(p.viewing_pk_ec)))).toBe(p.ss_ec)
    const { cipherText, sharedSecret } = ml_kem768.encapsulate(h(p.ek), h(v.given.m))
    expect(hex(cipherText)).toBe(p.ct)
    expect(hex(sharedSecret)).toBe(p.ss_pq)
    expect(hex(P.hybridCombine(h(p.ss_ec), h(p.ss_pq), h(p.epk), h(p.ct), h(p.viewing_pk_ec), h(p.ek)))).toBe(v.expect.ss)
  })
  it('V3-16: the stealth key and address', () => {
    const v = V['V3-16']
    expect(P.offsetOf(h(v.given.ss)).toString(16).padStart(64, '0')).toBe(v.expect.H_ss)
    expect(hex(P.stealthPkOf(h(v.given.spending_pk), h(v.given.ss)))).toBe(v.expect.stealth_pk)
    expect(hex(P.addressOf(h(v.expect.stealth_pk)))).toBe(v.expect.address)
  })
  it('V3-17: a scan with ACVP\'s key; the honest address matches and the lie is a skip', () => {
    const g = V['V3-17'].given
    const tracking = { viewingEc: h(g.viewing_ec), dk: h(V.acvp_decapsulation_tcId_86.dk), recipient: { spendingPk: h(g.spending_pk), viewingPk: h(g.viewing_pk_ec), ek: h(g.ek), meta: new Uint8Array() } }
    const entry = (a: string) => P.cat(h(a), h(g.announcement.ephemeralPubKey), h(g.announcement.metadata))
    expect(hex(P.scanS(tracking, entry(g.stealthAddress_honest))!)).toBe(V['V3-17'].expect.ss)
    expect(P.scanS(tracking, entry(g.stealthAddress_lie))).toBeUndefined()
  })
})

const yul = readFileSync(join(here, 'contracts/Board.yul'), 'utf8')
describe('Board.yul hard-codes the right constants', () => {
  it('each `case 0x........ { ... } // sig` is the selector of sig', () => {
    const cases = [...yul.matchAll(/case (0x[0-9a-f]{8}) \{[^}]*\}\s*\/\/ ([A-Za-z]+\([^)]*\))/g)]
    expect(cases.length).toBe(6)
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
  it('the post tag, OMEGA and the modulus', () => {
    expect(yul).toContain(`${X.POST_TAG.slice(2)}) // keccak256("exp-e2e-frames/17/post")`)
    expect(yul).toContain(`${numberToHex(B.OMEGA, { size: 32 })}) // OMEGA`)
    expect(yul).toContain(`${numberToHex(B.BLS_MODULUS, { size: 32 })}) // BLS_MODULUS`)
  })
})

const fixtures = new URL('./fixtures/x12/', import.meta.url).pathname
const runs = existsSync(fixtures) ? readdirSync(fixtures).filter((f) => f.endsWith('.json')) : []

describe.runIf(runs.length > 0)('the recorded runs rebuild', () => {
  for (const f of runs) {
    const fx = JSON.parse(readFileSync(join(fixtures, f), 'utf8'))
    const chainId = BigInt(fx.chainId)
    const blobs = Object.fromEntries((['S', 'N'] as const).map((k) => {
      const blob = B.packBlob(k === 'S' ? B.KIND.S : B.KIND.N, (fx[k].entries as Hex[]).map((e) => hexToBytes(e)))
      return [k, { blob, commitment: B.commitmentOf(blob) }]
    })) as Record<'S' | 'N', { blob: Uint8Array; commitment: Uint8Array }>
    it(`${f}: both blobs rebuild to the recorded versioned hashes and headers`, () => {
      for (const k of ['S', 'N'] as const) {
        expect(B.versionedHashOf(blobs[k].commitment)).toBe(fx[k].vh)
        expect(BigInt(bytesToHex(B.element(blobs[k].blob, 0)))).toBe(BigInt(fx[k].header))
      }
    })
    for (const t of fx.transactions as { step: string; hash: Hex; raw: Hex }[]) {
      it(`${f}: ${t.step}`, async () => {
        const tx = parseFrameTx(t.raw)
        expect(frameTxHash(tx).toLowerCase()).toBe(t.hash.toLowerCase())
        expect(tx.sender.toLowerCase()).toBe(fx.board.toLowerCase())
        expect(tx.frames.map((fr) => fr.mode)).toEqual([Mode.VERIFY, Mode.SENDER])
        expect(tx.frames[0].limits.execution).toBeLessThanOrEqual(X.VERIFY_LIMIT)
        expect(tx.blobVersionedHashes).toHaveLength(1)
        const vh = tx.blobVersionedHashes[0]
        const k = vh === fx.S.vh ? 'S' : 'N'
        expect(vh).toBe(fx[k].vh)
        expect(tx.nonceKeys).toEqual([0n])
        const w = (decodeFunctionData({ abi: X.boardAbi, data: tx.frames[1].data }).args as [bigint[]])[0]
        expect(w[0]).toBe(BigInt(fx[k].header))
        const word = (x: bigint) => numberToHex(x, { size: 32 })
        expect(await recoverAddress({ hash: X.postDigest(chainId, fx.board, vh, w[0], w[1]), signature: { r: word(w[5]), s: word(w[6]), v: w[7] } })).toBe(fx.packer)
        const kzg = hexToBytes(`0x${[w[2], w[3], w[4]].map((x) => word(x).slice(2)).join('')}`)
        expect(hex(kzg.subarray(0, 48))).toBe(hex(blobs[k].commitment))
        expect(B.verifyOpening(kzg.subarray(0, 48), 1n, hexToBytes(word(w[0])), kzg.subarray(48))).toBe(true)
      })
    }
    it.runIf(fx.answerA)(`${f}: archiver A's answer opens at its challenge's point`, () => {
      const kzg = hexToBytes(fx.answerA.kzg)
      expect(B.verifyOpening(kzg.subarray(0, 48), BigInt(fx.answerA.z), hexToBytes(fx.answerA.y), kzg.subarray(48))).toBe(true)
      expect(hex(kzg.subarray(0, 48))).toBe(hex(fx.answerA.seq === fx.S.seq ? blobs.S.commitment : blobs.N.commitment))
    })
  }
})
