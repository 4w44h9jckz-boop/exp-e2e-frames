// Experiment 18 (X13): the mailbox, an untrusted store this experiment runs, and the stand-in for
// an anonymous transport in front of it.
//
// The store is an HTTP service on this machine. Every call carries a blind ticket (experiment 16's
// threshold BLS ticket under this experiment's domain, tickets.ts): the store checks the issuers'
// signature on its own address and the serial, and refuses a serial it has seen. It keeps every
// message, and logs every field it receives with the time it received it. It never logs, and is
// never given, who called: every call arrives from the stand-in on the loopback interface.
//
//   put(tag, bytes)        a message under a 32-byte tag     get(tag)            the messages under it
//   post(bytes, flag)      a message to the push pool         since(cursor)       the pool from cursor
//   detect(cursor, key)    the pool from cursor, filtered by an FMD detection key
//
// The stand-in hides the caller and delays each call by an exponentially distributed time of mean
// delta seconds, as Loopix's mixes do. Cover traffic, when asked for, is puts and gets with random
// tags, paid with tickets like any other call.
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type Address, type Hex, bytesToHex, hexToBytes } from 'viem'
import * as F from './fmd.js'
import * as K from './tickets.js'

export type Ticket = { serial: Hex; sig: Hex }
export type LogEntry = { t: number; op: string; tag?: Hex; bytes?: number; serial: Hex; cursor?: number; returned?: number; flagged?: number; keys?: number }

export class Store {
  readonly log: LogEntry[] = []
  private boxes = new Map<string, Uint8Array[]>()
  private pool: { bytes: Uint8Array; flag: Uint8Array }[] = []
  private serials = new Set<string>()
  private server?: Server
  url = ''
  constructor(readonly address: Address, private issuersKey: Hex, private t0 = Date.now()) {}

  private paid(t: Ticket) {
    if (this.serials.has(t.serial)) throw new Error('serial already spent')
    if (!K.verifyTicket(this.issuersKey, this.address, t.serial, t.sig)) throw new Error('not a ticket')
    this.serials.add(t.serial)
  }
  private now = () => (Date.now() - this.t0) / 1000

  handle(op: string, b: Record<string, unknown>): unknown {
    const ticket = b.ticket as Ticket
    this.paid(ticket)
    switch (op) {
      case 'put': {
        const tag = b.tag as Hex
        const bytes = hexToBytes(b.bytes as Hex)
        this.log.push({ t: this.now(), op, tag, bytes: bytes.length, serial: ticket.serial })
        const box = this.boxes.get(tag) ?? []
        box.push(bytes)
        this.boxes.set(tag, box)
        return { ok: true }
      }
      case 'get': {
        const tag = b.tag as Hex
        const box = this.boxes.get(tag) ?? []
        this.log.push({ t: this.now(), op, tag, serial: ticket.serial, returned: box.length })
        return { messages: box.map((m) => bytesToHex(m)) }
      }
      case 'post': {
        const bytes = hexToBytes(b.bytes as Hex)
        const flag = hexToBytes(b.flag as Hex)
        this.log.push({ t: this.now(), op, bytes: bytes.length, serial: ticket.serial })
        this.pool.push({ bytes, flag })
        return { index: this.pool.length - 1 }
      }
      case 'since': {
        const cursor = Number(b.cursor)
        const out = this.pool.slice(cursor)
        this.log.push({ t: this.now(), op, cursor, serial: ticket.serial, returned: out.length })
        return { messages: out.map((m) => bytesToHex(m.bytes)), next: this.pool.length }
      }
      case 'detect': {
        const cursor = Number(b.cursor)
        const key = (b.key as string[]).map(BigInt)
        const dsk = F.extract(key, key.length)
        const hits: number[] = []
        for (let i = cursor; i < this.pool.length; i++) if (F.test(dsk, F.flagFrom(this.pool[i].flag))) hits.push(i)
        this.log.push({ t: this.now(), op, cursor, serial: ticket.serial, keys: key.length, flagged: hits.length })
        return { indices: hits, messages: hits.map((i) => bytesToHex(this.pool[i].bytes)), next: this.pool.length }
      }
      default:
        throw new Error(`no such call ${op}`)
    }
  }

  async listen(): Promise<string> {
    this.server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        try {
          const out = this.handle((req.url ?? '/').slice(1), JSON.parse(body))
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out))
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (e as Error).message }))
        }
      })
    })
    await new Promise<void>((ok) => this.server!.listen(0, '127.0.0.1', ok))
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`
    return this.url
  }
  close() { this.server?.close() }
}

/** The issuers, and a client's supply of tickets for one store, issued blindly in advance. */
export class Wallet {
  private supply: Ticket[] = []
  constructor(private issuers: K.Issuers, private store: Address, private seed: Hex, private label: string) {}
  buy(n: number) {
    for (let i = 0; i < n; i++) {
      const l = `${this.label}/${this.supply.length}/${i}`
      const serial = K.serialOf(this.seed, l)
      const factor = K.factorOf(this.seed, l)
      const { blinded } = K.blind(this.store, serial, factor)
      // unblind takes 0-based issuer indices (pass d2 stopped on 1-based ones).
      const answers = [0, 1, 2].map((j) => ({ issuer: j, answer: K.issuerAnswer(this.issuers, j, blinded) }))
      const sig = K.unblind(answers, factor)
      if (!K.verifyTicket(K.keyHex(this.issuers), this.store, serial, sig)) throw new Error('a ticket the issuers\' key refuses')
      this.supply.push({ serial, sig })
    }
  }
  next(): Ticket {
    const t = this.supply.shift()
    if (!t) throw new Error('out of tickets')
    return t
  }
}

/** An exponential draw of mean `mean`, from a uniform in (0, 1]. */
export const expDraw = (mean: number, u: number) => (mean <= 0 ? 0 : -mean * Math.log(u))

/** The stand-in: it drops who called, waits an exponential delay, and forwards the call. */
export class Transport {
  readonly delays: number[] = []
  constructor(private url: string, private meanSeconds: number, private uniform: () => number = Math.random) {}
  async call(op: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const delay = expDraw(this.meanSeconds, 1 - this.uniform())
    this.delays.push(delay)
    await new Promise((r) => setTimeout(r, delay * 1000))
    const res = await fetch(`${this.url}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const out = await res.json()
    if (!res.ok) throw new Error(`${op}: ${out.error}`)
    return out
  }
}
