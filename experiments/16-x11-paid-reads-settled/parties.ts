// Experiment 16 (X11): the parties off chain. Each attester keeps its own state and makes its own
// checks; the runner only carries messages between them. An honest attester signs only what it saw
// itself. The dishonest one signs whatever it is asked to, and keeps what it signed, so its
// conflicting signatures exist to be reported.
import { x25519 } from '@noble/curves/ed25519'
import { type Address, type Hex, bytesToHex, concatHex, hexToBytes, keccak256, toHex } from 'viem'
import { verifyTicket } from './tickets.js'
import { type Batch, type Sig, batchDigest, epochEnd, epochOf, refundDigest, rootOf, signDigest } from './x11.js'

export type Delivery = { server: Address; serial: Hex; ticket: Hex; ciphertext: Hex }
export type Verdict = { ok: true } | { ok: false; reason: string }

export class Attester {
  /** serial -> what was delivered, in which epoch, at which head. */
  readonly delivered = new Map<Hex, { server: Address; epoch: bigint; head: bigint; ciphertext: Hex }>()
  /** serial -> what this attester signed it into: one batch or one refund. */
  readonly signed = new Map<Hex, 'batch' | 'refund'>()
  /** serial -> the head at which the refund was first asked for. */
  readonly refundAsked = new Map<Hex, bigint>()
  /** Every signature it gave, by digest, so a reporter can collect them. */
  readonly signatures = new Map<Hex, Sig>()
  checkMillis: number[] = []

  constructor(
    readonly index: number,
    private readonly privateKey: Hex,
    readonly honest: boolean,
    private readonly issuersKey: Hex,
    private readonly chainId: bigint,
    private readonly pool: Address,
  ) {}

  /** A server hands over a delivery: the ticket it took and the reader's answer, encrypted. */
  deliver(d: Delivery, head: bigint): Verdict {
    const t0 = performance.now()
    const valid = verifyTicket(this.issuersKey, d.server, d.serial, d.ticket)
    this.checkMillis.push(performance.now() - t0)
    if (!valid) return { ok: false, reason: 'the ticket is not the issuers\' signature for this server' }
    if (this.delivered.has(d.serial)) return { ok: false, reason: 'already delivered' }
    if (this.signed.has(d.serial)) return { ok: false, reason: `already signed into a ${this.signed.get(d.serial)}` }
    this.delivered.set(d.serial, { server: d.server, epoch: epochOf(head), head, ciphertext: d.ciphertext })
    return { ok: true }
  }

  /** A reader whose server withheld the answer asks for it. */
  fetch(serial: Hex): Hex | undefined {
    return this.delivered.get(serial)?.ciphertext
  }

  /** A server asks for a signature on its batch for an epoch that has ended. */
  async signBatch(b: Batch, head: bigint): Promise<Sig | Verdict> {
    if (this.honest) {
      if (head <= epochEnd(b.epoch)) return { ok: false, reason: 'the epoch has not ended' }
      if (new Set(b.serials).size !== b.serials.length) return { ok: false, reason: 'a serial twice in the batch' }
      for (const s of b.serials) {
        if (this.signed.has(s)) return { ok: false, reason: `serial ${s.slice(0, 10)} is already in a signed ${this.signed.get(s)}` }
        const d = this.delivered.get(s)
        if (!d) return { ok: false, reason: `serial ${s.slice(0, 10)} was never delivered to me` }
        if (d.server !== b.server) return { ok: false, reason: `serial ${s.slice(0, 10)} was delivered by another server` }
        if (d.epoch !== b.epoch) return { ok: false, reason: `serial ${s.slice(0, 10)} was delivered in epoch ${d.epoch}` }
      }
    }
    for (const s of b.serials) if (!this.signed.has(s)) this.signed.set(s, 'batch')
    return this.give(batchDigest(this.chainId, this.pool, b))
  }

  /** A reader asks for its refund: first noted, then signed once a whole epoch has passed. */
  async signRefund(r: { server: Address; serial: Hex; ticket: Hex; recipient: Address }, head: bigint): Promise<Sig | Verdict> {
    if (!this.refundAsked.has(r.serial)) this.refundAsked.set(r.serial, head)
    if (this.honest) {
      if (!verifyTicket(this.issuersKey, r.server, r.serial, r.ticket)) return { ok: false, reason: 'the ticket is not the issuers\' signature' }
      if (head <= epochEnd(epochOf(this.refundAsked.get(r.serial)!))) return { ok: false, reason: 'the server still has until the end of this epoch' }
      if (this.delivered.has(r.serial)) return { ok: false, reason: 'it was delivered' }
      if (this.signed.has(r.serial)) return { ok: false, reason: `already signed into a ${this.signed.get(r.serial)}` }
    }
    if (!this.signed.has(r.serial)) this.signed.set(r.serial, 'refund')
    return this.give(refundDigest(this.chainId, this.pool, r.serial, r.recipient))
  }

  private async give(digest: Hex): Promise<Sig> {
    const sig = await signDigest(this.privateKey, this.index, digest)
    this.signatures.set(digest, sig)
    return sig
  }
}

export const isSig = (x: Sig | Verdict): x is Sig => 'r' in x

/** The stand-in service: an answer computed from the query, encrypted to the reader's key. */
export const answerOf = (query: Hex): Hex => keccak256(concatHex([toHex('exp-e2e-frames/16/answer'), query]))
const pad32 = (seed: Uint8Array, serial: Hex) => hexToBytes(keccak256(concatHex([bytesToHex(seed), serial])))
const xor = (a: Uint8Array, b: Uint8Array) => a.map((x, i) => x ^ b[i])

export class Server {
  readonly spent = new Set<Hex>()
  constructor(
    readonly address: Address,
    private readonly issuersKey: Hex,
    private readonly ephemeral: Uint8Array,
  ) {}

  /** A read: the ticket first, then the answer, encrypted to the reader's X25519 key. */
  handle(q: { query: Hex; serial: Hex; ticket: Hex; readerKey: Hex }): { ciphertext: Hex; serverKey: Hex } | Verdict {
    if (!verifyTicket(this.issuersKey, this.address, q.serial, q.ticket)) return { ok: false, reason: 'not a ticket for this server' }
    if (this.spent.has(q.serial)) return { ok: false, reason: 'spent' }
    this.spent.add(q.serial)
    const shared = x25519.getSharedSecret(this.ephemeral, hexToBytes(q.readerKey))
    return { ciphertext: bytesToHex(xor(hexToBytes(answerOf(q.query)), pad32(shared, q.serial))), serverKey: bytesToHex(x25519.getPublicKey(this.ephemeral)) }
  }
}

/** The reader decrypts an answer, from the server or from an attester. */
export function decrypt(readerSecret: Uint8Array, serverKey: Hex, serial: Hex, ciphertext: Hex): Hex {
  const shared = x25519.getSharedSecret(readerSecret, hexToBytes(serverKey))
  return bytesToHex(xor(hexToBytes(ciphertext), pad32(shared, serial)))
}

export { rootOf }
