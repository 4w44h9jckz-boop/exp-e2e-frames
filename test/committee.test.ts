// The committees' recorded checks, offline. C2: each member's proof is checked again here with
// noble's BN254 pairing, an implementation of its own: the members proved with co-snarks over
// arkworks, and the chain's verifier answered on EIP-196 and EIP-197's precompiles. The key
// paired against is the one in the chain's verifier: every coordinate of it is in the recorded
// code.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { bn254 } from '@noble/curves/bn254'
import { type Hex, keccak256, numberToHex } from 'viem'
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
  it('Cargo.toml takes every git piece at the commit pins.json names', () => {
    const pins = JSON.parse(readFileSync(join(COMMITTEE, 'pins.json'), 'utf8'))
    const cargo = readFileSync(join(COMMITTEE, 'Cargo.toml'), 'utf8')
    for (const [, pin] of Object.entries<{ url: string; commit: string }>(pins)) {
      const lines = cargo.split('\n').filter((l) => l.includes(`git = "${pin.url}"`))
      expect(lines.length).toBeGreaterThan(0)
      for (const l of lines) expect(l).toContain(`rev = "${pin.commit}"`)
    }
  })
})

describe.each(fixtures('c2-'))('C2 %s', (file) => {
  const r = JSON.parse(readFileSync(join(DIR, file), 'utf8'))

  it('was made from a committed tree, with the pins of its time', () => {
    expect(r.entry).toBe('C2')
    expect(r.repoCommit).toMatch(/^[0-9a-f]{40}$/)
    for (const p of Object.values<{ commit: string }>(r.pins)) expect(p.commit).toMatch(/^[0-9a-f]{40}$/)
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
