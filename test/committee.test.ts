// The committees' recorded checks, offline. C2: each member's proof is checked again here with
// noble's BN254 pairing, an implementation of its own: the members proved with co-snarks over
// arkworks, and the chain's verifier answered on EIP-196 and EIP-197's precompiles. The key
// paired against is the one in the chain's verifier: every coordinate of it is in the recorded
// code.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { bls12_381 as bls } from '@noble/curves/bls12-381'
import { bn254 } from '@noble/curves/bn254'
import { type Hex, concatHex, hexToBigInt, hexToBytes, keccak256, numberToHex, slice, stringToHex } from 'viem'
import { describe, expect, it } from 'vitest'

const DIR = new URL('./fixtures/committee/', import.meta.url).pathname
const COMMITTEE = new URL('../committee/', import.meta.url).pathname
const fixtures = (prefix: string) =>
  existsSync(DIR) ? readdirSync(DIR).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort() : []

const { G1, G2 } = bn254
const g1 = (p: string[]) => G1.ProjectivePoint.fromAffine({ x: BigInt(p[0]), y: BigInt(p[1]) })
const g2 = (p: string[][]) =>
  G2.ProjectivePoint.fromAffine({
    x: bn254.fields.Fp2.fromBigTuple([BigInt(p[0][0]), BigInt(p[0][1])]),
    y: bn254.fields.Fp2.fromBigTuple([BigInt(p[1][0]), BigInt(p[1][1])]),
  })

type Vk = { alpha: string[]; beta: string[][]; gamma: string[][]; delta: string[][]; ic: string[][] }
type WebsnarkProof = { pi_a: string[]; pi_b: string[][]; pi_c: string[] }

/** Groth16's check: e(A, B) = e(alpha, beta) e(L, gamma) e(C, delta), L = IC_0 + sum x_i IC_i. */
function groth16(vk: Vk, proof: WebsnarkProof, inputs: string[]): boolean {
  let l = g1(vk.ic[0])
  inputs.forEach((x, i) => {
    const s = BigInt(x)
    if (s !== 0n) l = l.add(g1(vk.ic[i + 1]).multiply(s))
  })
  const a = g1(proof.pi_a.slice(0, 2))
  const b = g2(proof.pi_b.slice(0, 2))
  const c = g1(proof.pi_c.slice(0, 2))
  const { Fp12 } = bn254.fields
  const lhs = bn254.pairing(a, b)
  const rhs = Fp12.mul(Fp12.mul(bn254.pairing(g1(vk.alpha), g2(vk.beta)), bn254.pairing(l, g2(vk.gamma))), bn254.pairing(c, g2(vk.delta)))
  return Fp12.eql(lhs, rhs)
}

const word = (x: string) => numberToHex(BigInt(x), { size: 32 }).slice(2)
/** The PUSH instruction solc emits for a constant: PUSH1 to PUSH32, leading zero bytes dropped. */
const push = (x: string) => {
  const hex = numberToHex(BigInt(x)).slice(2).padStart(2, '0').replace(/^(00)+(?=..)/, '')
  const padded = hex.length % 2 ? `0${hex}` : hex
  return (0x5f + padded.length / 2).toString(16) + padded
}

describe('the committees workspace pins what pins.json says', () => {
  it('every piece names its licence', () => {
    const pins = JSON.parse(readFileSync(join(COMMITTEE, 'pins.json'), 'utf8'))
    for (const [name, pin] of Object.entries<{ licence?: string }>(pins)) expect(pin.licence, name).toBeTruthy()
  })

  it('Cargo.toml takes every git piece at the commit pins.json names', () => {
    const pins = JSON.parse(readFileSync(join(COMMITTEE, 'pins.json'), 'utf8'))
    const cargo = ['Cargo.toml', 'fhe-committee/Cargo.toml'].map((f) => readFileSync(join(COMMITTEE, f), 'utf8')).join('\n')
    for (const [, pin] of Object.entries<{ url: string; commit: string }>(pins)) {
      if (pin.commit.startsWith('crates.io')) continue
      const lines = cargo.split('\n').filter((l) => l.includes(`git = "${pin.url}"`))
      expect(lines.length, pin.url).toBeGreaterThan(0)
      for (const l of lines) expect(l).toContain(`rev = "${pin.commit}"`)
    }
  })
})

describe.each(fixtures('c2-'))('C2 %s', (file) => {
  const r = JSON.parse(readFileSync(join(DIR, file), 'utf8'))

  it('was made from a committed tree, with the pins of its time', () => {
    expect(r.entry).toBe('C2')
    expect(r.repoCommit).toMatch(/^[0-9a-f]{40}$/)
    for (const p of Object.values<{ commit: string }>(r.pins)) expect(p.commit).toMatch(/^[0-9a-f]{40}$|^crates\.io /)
  })

  it('three members agree on one proof', () => {
    expect(r.members).toHaveLength(3)
    expect(r.members.map((m: { member: number }) => m.member)).toEqual([0, 1, 2])
    for (const m of r.members) {
      expect(m.solidity).toBe(r.members[0].solidity)
      expect(m.publicInputs).toEqual(r.members[0].publicInputs)
      expect(m.verified).toBe(true)
    }
  })

  it('the key paired against is the one in the chain verifier code', () => {
    expect(keccak256(r.chain.verifierCode as Hex)).toBe(r.chain.verifierCodeHash)
    const code = (r.chain.verifierCode as string).toLowerCase()
    const coords = [...r.vk.alpha, ...r.vk.beta.flat(), ...r.vk.gamma.flat(), ...r.vk.delta.flat(), ...r.vk.ic.flat()]
    for (const x of coords) expect(code).toContain(push(x))
    expect(r.vk.ic).toHaveLength(7)
  })

  it('noble accepts the proof, and refuses it with one public input changed', () => {
    const m = r.members[0]
    expect(groth16(r.vk, m.proof, m.publicInputs)).toBe(true)
    const tampered = m.publicInputs.map((x: string, i: number) => (i === r.chain.tamperedIndex ? (BigInt(x) + 1n).toString() : x))
    expect(groth16(r.vk, m.proof, tampered)).toBe(false)
  })

  it('the solidity bytes are the proof, B in the precompile order', () => {
    const p = r.members[0].proof as WebsnarkProof
    const words = [p.pi_a[0], p.pi_a[1], p.pi_b[0][1], p.pi_b[0][0], p.pi_b[1][1], p.pi_b[1][0], p.pi_c[0], p.pi_c[1]]
    expect(r.members[0].solidity).toBe(`0x${words.map(word).join('')}`)
  })

  it('the chain verifier accepted the proof and refused it with one input changed', () => {
    expect(r.chain.verifier).toBe('0x87a7C1f76b03dA00de489897d436BbEDDd2133b7')
    expect(r.chain.accepts).toBe(true)
    expect(r.chain.acceptsTampered).toBe(false)
  })

  it('every byte one member sent, its peer received, and the time names its network', () => {
    for (const m of r.members) {
      expect(m.network).toMatch(/loopback/)
      for (const p of m.peers) {
        const back = r.members[p.peer].peers.find((q: { peer: number }) => q.peer === m.member)
        expect(back.bytesReceived).toBe(p.bytesSent)
        expect(back.messagesReceived).toBe(p.messagesSent)
      }
    }
  })
})

/** EIP-2537's encodings, read back into noble's points. */
const g1Eip2537 = (b: Hex) => {
  const p = bls.G1.ProjectivePoint.fromAffine({ x: hexToBigInt(slice(b, 0, 64)), y: hexToBigInt(slice(b, 64, 128)) })
  p.assertValidity()
  return p
}
const g2Eip2537 = (b: Hex) => {
  const c = [0, 1, 2, 3].map((i) => hexToBigInt(slice(b, 64 * i, 64 * (i + 1))))
  const p = bls.G2.ProjectivePoint.fromAffine({
    x: bls.fields.Fp2.fromBigTuple([c[0], c[1]]),
    y: bls.fields.Fp2.fromBigTuple([c[2], c[3]]),
  })
  p.assertValidity()
  return p
}
const RESULT_DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_POP_'
/** Commonware's MinSig check: e(sigma, g2) = e(H(union_unique(namespace, message)), PK). */
function blsVerify(namespace: string, message: Hex, signature: Hex, key: Hex): boolean {
  const ns = hexToBytes(stringToHex(namespace))
  const h = bls.G1.hashToCurve(new Uint8Array([ns.length, ...ns, ...hexToBytes(message)]), { DST: RESULT_DST })
  const lhs = bls.pairing(g1Eip2537(signature), bls.G2.ProjectivePoint.BASE)
  const rhs = bls.pairing(bls.G1.ProjectivePoint.fromAffine(h.toAffine()), g2Eip2537(key))
  return bls.fields.Fp12.eql(lhs, rhs)
}

describe.each(fixtures('c1-'))('C1 %s', (file) => {
  const r = JSON.parse(readFileSync(join(DIR, file), 'utf8'))

  it('was made from a committed tree, and its time names its network', () => {
    expect(r.entry).toBe('C1')
    expect(r.repoCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(r.network).toMatch(/one process/)
  })

  it('the coprocessor evaluated the input and four members decrypted it', () => {
    expect(r.decryption.value).toBe(r.input.value + 1)
    expect(r.steps.verifyInput.stdout).toBe('valid')
    expect(r.refusedUnderOtherMetadata).toBe(true)
    expect(r.decryption.members).toHaveLength(4)
    const sum = (k: string) => r.decryption.members.reduce((a: number, m: Record<string, number>) => a + m[k], 0)
    expect(sum('bytesSent')).toBe(sum('bytesReceived'))
    expect(sum('messagesSent')).toBe(sum('messagesReceived'))
    for (const m of r.decryption.members) expect(m.rounds).toBeGreaterThan(0)
  })

  it('the signed message is chain id, request, the result handle and the value', () => {
    const s = r.signed
    expect(s.handle).toBe(r.resultHandle)
    expect(s.value).toBe(r.decryption.value)
    expect(s.message).toBe(concatHex([numberToHex(s.chainId, { size: 32 }), s.request, s.handle, numberToHex(s.value, { size: 32 })]))
    expect(r.below.message).toBe(s.message)
  })

  it('a quorum of three signed; two could not, and their best is refused by noble and by the chain', () => {
    expect(r.bls.members).toBe(4)
    expect(r.bls.quorum).toBe(3)
    expect(r.signed.signers).toHaveLength(3)
    expect(r.signed.verified).toBe(true)
    expect(r.signRefusedBelowQuorum).toBe(true)
    expect(r.below.signers).toHaveLength(2)
    expect(r.below.verified).toBe(false)
    expect(blsVerify(r.signed.namespace, r.signed.message, r.signed.signatureEip2537, r.signed.keyEip2537)).toBe(true)
    expect(blsVerify(r.below.namespace, r.below.message, r.below.signatureEip2537, r.below.keyEip2537)).toBe(false)
    expect(r.chain.pairingAcceptsSigned).toBe(true)
    expect(r.chain.pairingAcceptsBelow).toBe(false)
  })

  it('names its budget, its shape, who sees the partials, and what Commonware threshold means', () => {
    expect(r.budget.nodes).toBe(500_000)
    expect(r.budget.pairingAlone).toBeGreaterThan(r.budget.eip8141PublicMempool)
    expect(r.shape).toMatch(/shape, not the product/)
    expect(r.whoSeesPartials).toBeTruthy()
    expect(r.bls.commonware.thresholdParameter).toMatch(/^q:/)
    expect(r.bls.commonware.polynomialDegree).toBe(r.bls.quorum - 1)
    expect(typeof r.bls.commonware.qualifiedSetFixedBeforeKeyDependentValues).toBe('boolean')
    // q > (n + t) / 2, t the members that may be corrupted
    expect(r.bls.quorum).toBeGreaterThan((r.bls.members + r.bls.commonware.maxFaults) / 2)
  })

  it('a result signature is not accepted for a request it was not made for (noble and the chain)', () => {
    expect(blsVerify(r.signed.namespace, r.chain.otherMessage, r.signed.signatureEip2537, r.signed.keyEip2537)).toBe(false)
    expect(r.chain.pairingAcceptsForOtherRequest).toBe(false)
    expect(r.chain.otherMessage).not.toBe(r.signed.message)
  })

  it('a second result for the same request gets no signature, even with a corrupted member', () => {
    for (const x of [r.secondResult, r.secondResultCorrupt]) {
      expect(x.exitOk).toBe(false)
      expect(x.signed).toBe(false)
      expect(x.request).toBe(r.signed.request)
      expect(x.value).not.toBe(r.signed.value)
      expect(x.partials).toBeLessThan(r.bls.quorum)
    }
    expect(r.secondResult.refusals.map((x: { member: number }) => x.member).sort()).toEqual(r.signed.signers.slice().sort())
    expect(r.secondResultCorrupt.ignoredLocks).toEqual([0])
  })

  it('t members, and q - 1, holding their shares and the DKG output, forge nothing (noble and the chain)', () => {
    expect(r.forgeT.members).toHaveLength(r.bls.commonware.maxFaults)
    expect(r.forgeQ1.members).toHaveLength(r.bls.quorum - 1)
    const attempts = [...r.forgeT.attempts, ...r.forgeQ1.attempts]
    expect(attempts.length).toBeGreaterThan(2)
    for (const a of attempts) {
      expect(a.verified).toBe(false)
      expect(blsVerify(r.signed.namespace, r.forgeT.message, a.signatureEip2537, r.signed.keyEip2537)).toBe(false)
    }
    expect(r.chain.pairingAcceptsForged).toHaveLength(attempts.length)
    expect(r.chain.pairingAcceptsForged.every((x: boolean) => x === false)).toBe(true)
  })

  it('each partial checks against its member key, and the DKG traffic adds up', () => {
    for (const p of r.signed.partials) {
      const id = r.bls.identities.find((i: { index: number }) => i.index === p.index)
      expect(blsVerify(r.signed.namespace, r.signed.message, p.signatureEip2537, id.partialKeyEip2537)).toBe(true)
    }
    const sum = (k: string) => r.bls.dkg.reduce((a: number, m: Record<string, number>) => a + m[k], 0)
    expect(sum('bytesSent')).toBe(sum('bytesReceived'))
    for (const m of r.bls.dkg) expect(m.rounds).toBe(3)
  })
})
