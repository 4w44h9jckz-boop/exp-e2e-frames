// Experiment 10 (C6), every recorded run checked offline. Written before the first run, with the
// README's claim: these checks are what would show it wrong.
//
// - A threshold signature can be attributed after all: shown wrong if two different quorums made
//   different signatures.
// - Naming the signers costs more than a VERIFY frame pays: shown wrong if, at a committee size
//   Appendix F names (3-of-5, 7-of-10, 13, 256), an accountable spend is not mined, or its VERIFY
//   frame uses more than 500,000 gas, the most the testnet's nodes admit.
//
// Every signature is checked again with noble's BLS12-381: the threshold one under the group key,
// the aggregate under the named signers' keys, and each individual one under its own signer's.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { bls12_381 as bls } from '@noble/curves/bls12-381'
import { type Hex, concatHex, hexToBigInt, hexToBytes, keccak256, numberToHex, slice, stringToHex } from 'viem'
import { describe, expect, it } from 'vitest'

const DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_POP_'
const NAMED_SIZES = [5, 10, 13, 256]
const NODE_VERIFY_BUDGET = 500_000
const here = new URL('../experiments/10-c6-accountable-signers/', import.meta.url).pathname

const word = (n: bigint | number) => numberToHex(BigInt(n), { size: 32 })
const nonceKeysHash = (keys: bigint[]): Hex => keccak256(concatHex([word(keys.length), ...keys.map(word)]))
const message = (chainId: number, sender: Hex, salt: Hex): Hex =>
  concatHex([word(chainId), sender, nonceKeysHash([0n]), numberToHex(0n, { size: 8 }), numberToHex(0n, { size: 8 }), salt])
const point = (namespace: string, m: Hex) => {
  const ns = hexToBytes(stringToHex(namespace))
  return bls.G1.ProjectivePoint.fromAffine(bls.G1.hashToCurve(new Uint8Array([ns.length, ...ns, ...hexToBytes(m)]), { DST }).toAffine())
}
const g1 = (b: Hex) => {
  const p = bls.G1.ProjectivePoint.fromAffine({ x: hexToBigInt(slice(b, 0, 64)), y: hexToBigInt(slice(b, 64, 128)) })
  p.assertValidity()
  return p
}
const g2 = (b: Hex) => {
  const c = [0, 1, 2, 3].map((i) => hexToBigInt(slice(b, 64 * i, 64 * (i + 1))))
  const p = bls.G2.ProjectivePoint.fromAffine({
    x: bls.fields.Fp2.fromBigTuple([c[0], c[1]]),
    y: bls.fields.Fp2.fromBigTuple([c[2], c[3]]),
  })
  p.assertValidity()
  return p
}
// biome-ignore lint: noble's point types
const verifies = (h: any, sig: any, key: any) =>
  bls.fields.Fp12.eql(bls.pairing(sig, bls.G2.ProjectivePoint.BASE), bls.pairing(h, key))

describe('AccountablePaymaster.hex is its Yul compiled', () => {
  it('by solc 0.8.37, EVM osaka, optimizer on, 200 runs, as the ticket paymaster is', () => {
    const solc = createRequire(import.meta.url)('solc') as { compile(i: string): string; version(): string }
    expect(solc.version()).toMatch(/^0\.8\.37\+/)
    const source = readFileSync(join(here, 'contracts/AccountablePaymaster.yul'), 'utf8')
    const input = {
      language: 'Yul',
      sources: { a: { content: source } },
      settings: { evmVersion: 'osaka', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['evm.bytecode.object'] } } },
    }
    const out = JSON.parse(solc.compile(JSON.stringify(input)))
    const [c] = Object.values(out.contracts.a) as { evm: { bytecode: { object: string } } }[]
    expect(c.evm.bytecode.object).toBe(readFileSync(join(here, 'contracts/AccountablePaymaster.hex'), 'utf8').trim())
  })
})

const dir = join(here, 'results')
const runs = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((file) => ({ file, r: JSON.parse(readFileSync(join(dir, file), 'utf8')) })) : []

for (const { file, r } of runs)
  describe(`experiment 10, ${file}`, () => {
    const s = r.sent

    it('pins every piece at a full commit', () => {
      for (const pin of Object.values(r.pins) as { commit: string }[]) expect(pin.commit).toMatch(/^[0-9a-f]{40}$/)
    })

    it('measured every size Appendix F names', () => {
      for (const n of NAMED_SIZES) expect(s.sizes.find((x: { n: number }) => x.n === n), `size ${n}`).toBeDefined()
    })

    for (const x of s.sizes) {
      describe(`n = ${x.n}`, () => {
        it('a quorum of n - f, with f = floor((n - 1) / 3)', () => {
          expect(x.f).toBe(Math.floor((x.n - 1) / 3))
          expect(x.quorum).toBe(x.n - x.f)
        })

        it('the threshold signature is the same from two quorums, so it names no one', () => {
          expect(x.threshold.sameSignatureFromTwoQuorums).toBe(true)
          expect(x.threshold.signatureFromQuorumA).toBe(x.threshold.signatureFromQuorumB)
        })

        it('the threshold signature verifies under the group key (noble), and the chain paid it from the ticket paymaster', () => {
          const sp = x.threshold.spend
          expect(verifies(point(s.ticketNamespace, message(s.chainId, sp.sender, sp.salt)), g1(sp.signatureEip2537), g2(x.threshold.keyEip2537))).toBe(true)
          expect(sp.mined).toBe(true)
          expect(sp.paidByPaymaster).toBe(true)
          expect(r.chain[sp.hash].status).toBe('0x1')
          expect(sp.raw.toLowerCase()).toContain(sp.verifyData.slice(2).toLowerCase())
        })

        it('the accountable data names exactly the quorum, carries the committed keys, and each signature checks (noble)', () => {
          const keys: Hex = x.accountable.keysEip2537
          expect(keccak256(keys)).toBe(x.accountable.keysCommit)
          const keyAt = (i: number) => g2(slice(keys, 256 * i, 256 * (i + 1)))
          for (const sp of x.accountable.spends) {
            const bitmap = hexToBytes(sp.bitmap)
            const named = [...Array(x.n).keys()].filter((i) => (bitmap[i >> 3] >> (i & 7)) & 1)
            expect(named).toHaveLength(x.quorum)
            const h = point(s.accountableNamespace, message(s.chainId, sp.sender, sp.salt))
            // Each signer's own signature verifies under its own key: who signed is named.
            sp.signaturesEip2537.forEach((sig: Hex, j: number) => expect(verifies(h, g1(sig), keyAt(named[j]))).toBe(true))
            const sumKeys = named.map(keyAt).reduce((a, b) => a.add(b))
            const sumSigs = sp.signaturesEip2537.map(g1).reduce((a: any, b: any) => a.add(b))
            expect(verifies(h, sumSigs, sumKeys)).toBe(true)
            expect(sp.raw.toLowerCase()).toContain(sp.verifyData.slice(2).toLowerCase())
            expect(sp.verifyDataBytes).toBe((sp.verifyData.length - 2) / 2)
          }
        })

        if (NAMED_SIZES.includes(x.n))
          it('naming the signers fits a VERIFY frame the testnet nodes admit', () => {
            for (const sp of x.accountable.spends) {
              expect(sp.mined, `${sp.mode}: ${JSON.stringify(sp.answer)}`).toBe(true)
              expect(sp.paidByPaymaster).toBe(true)
              expect(sp.frames[1].gasUsed).toBeLessThanOrEqual(NODE_VERIFY_BUDGET)
            }
          })
      })
    }
  })
