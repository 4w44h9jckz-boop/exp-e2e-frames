// Experiment 16 (X11): read tickets, as exp-frames experiment 37's. A ticket is the issuers'
// threshold BLS signature (signatures in G1, the key in G2) on server || serial, under a domain
// for read tickets, issued blindly: the reader hashes its message to G1, multiplies the point by
// a random factor, and divides the issuers' combined answer by it. No issuer sees the message or
// the signature it ends up in.
//
// The issuers' key here is dealt by one process (Shamir over the scalar field, quorum 3 of 4).
// Experiment 04 and exp-frames 36 made theirs with Commonware's DKG; issuance is not what this
// experiment tests.
import { bls12_381 as bls } from '@noble/curves/bls12-381'
import { type Address, type Hex, bytesToHex, concatHex, hexToBigInt, hexToBytes, keccak256, pad, toHex } from 'viem'

const Fr = bls.fields.Fr
const G1 = bls.G1.ProjectivePoint
const G2 = bls.G2.ProjectivePoint
type P1 = InstanceType<typeof G1>
type P2 = InstanceType<typeof G2>

export const DST = 'EXP-E2E-FRAMES-16-READ-TICKET-V1_BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_'
export const ISSUERS = 4
export const ISSUER_QUORUM = 3

/** A scalar from a seed and a label: deterministic, so every script sees the same values. */
const scalarOf = (seed: Hex, l: string) => (hexToBigInt(keccak256(concatHex([seed, toHex(`exp-e2e-frames/16/${l}`)]))) % (Fr.ORDER - 1n)) + 1n

export type Issuers = { key: P2; shares: bigint[] }

/** The issuers' key and its four shares, from a polynomial of degree 2 dealt by one process. */
export function dealIssuers(seed: Hex): Issuers {
  const coeffs = [0, 1, 2].map((i) => scalarOf(seed, `issuers/coefficient/${i}`))
  const at = (x: bigint) => coeffs.reduceRight((acc, c) => Fr.add(Fr.mul(acc, x), c), 0n)
  return { key: G2.BASE.multiply(coeffs[0]), shares: [1n, 2n, 3n, 4n].map(at) }
}

/** The key as EIP-2537 would read it, and as the record keeps it: 96 compressed bytes. */
export const keyHex = (i: Issuers): Hex => bytesToHex(i.key.toRawBytes(true))

/** What a ticket signs: the server, left-padded to 32 bytes, then the serial. */
export const ticketMessage = (server: Address, serial: Hex): Uint8Array => hexToBytes(concatHex([pad(server), serial]))
const hashed = (server: Address, serial: Hex): P1 => bls.G1.hashToCurve(ticketMessage(server, serial), { DST }) as unknown as P1

/** The reader's side: the blinded point it sends, and the factor it keeps. */
export function blind(server: Address, serial: Hex, factor: bigint): { blinded: Hex } {
  return { blinded: bytesToHex(hashed(server, serial).multiply(factor).toRawBytes(true)) }
}

/** One issuer's answer to a blinded point: its share times the point. */
export function issuerAnswer(issuers: Issuers, i: number, blinded: Hex): Hex {
  return bytesToHex(G1.fromHex(blinded.slice(2)).multiply(issuers.shares[i]).toRawBytes(true))
}

/** Lagrange's coefficient at 0 for issuer `i` (1-based x) among `xs`. */
function lagrange(i: bigint, xs: bigint[]): bigint {
  let num = 1n
  let den = 1n
  for (const j of xs) {
    if (j === i) continue
    num = Fr.mul(num, j)
    den = Fr.mul(den, Fr.sub(j, i))
  }
  return Fr.div(num, den)
}

/** The reader combines a quorum's answers and divides out its factor: the ticket. */
export function unblind(answers: { issuer: number; answer: Hex }[], factor: bigint): Hex {
  if (answers.length < ISSUER_QUORUM) throw new Error('fewer answers than the quorum')
  const xs = answers.map((a) => BigInt(a.issuer + 1))
  let acc = G1.ZERO
  for (const a of answers) acc = acc.add(G1.fromHex(a.answer.slice(2)).multiply(lagrange(BigInt(a.issuer + 1), xs)))
  return bytesToHex(acc.multiply(Fr.inv(factor)).toRawBytes(true))
}

/** Is `ticket` the issuers' signature on server || serial? */
export function verifyTicket(key: Hex, server: Address, serial: Hex, ticket: Hex): boolean {
  try {
    const sig = G1.fromHex(ticket.slice(2))
    const pk = G2.fromHex(key.slice(2))
    return bls.fields.Fp12.eql(bls.pairing(sig, G2.BASE), bls.pairing(hashed(server, serial), pk))
  } catch {
    return false
  }
}

/** A reader's blinding factor and serial, from its seed and the ticket's label. */
export const factorOf = (seed: Hex, l: string) => scalarOf(seed, `reader/factor/${l}`)
export const serialOf = (seed: Hex, l: string): Hex => keccak256(concatHex([seed, toHex(`exp-e2e-frames/16/reader/serial/${l}`)]))
