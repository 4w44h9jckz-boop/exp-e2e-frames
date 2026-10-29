// Experiment 16 (X11), offline: blind issuance, reads, the attesters' checks, batch roots and paths,
// and every signature recovering to its member, with no chain. The contract's own checks run only
// on the test network (simulation, then the run).
//
// usage: npx tsx experiments/16-x11-paid-reads-settled/selfcheck.ts
import { x25519 } from '@noble/curves/ed25519'
import { type Hex, hexToBytes, keccak256, recoverAddress, toHex } from 'viem'
import { Attester, Server, answerOf, decrypt, isSig } from './parties.js'
import { blind, dealIssuers, factorOf, issuerAnswer, keyHex, serialOf, unblind, verifyTicket } from './tickets.js'
import * as X from './x11.js'

const base = keccak256(toHex('exp-e2e-frames/16/selfcheck')) as Hex
const chainId = 8141n
const pool = X.poolOf(base)
const issuers = dealIssuers(base)
const key = keyHex(issuers)
const check = (what: string, ok: boolean) => {
  if (!ok) throw new Error(`selfcheck: ${what}`)
  console.log(`ok  ${what}`)
}

// Issuance: blind, three answers of four, unblind; the ticket verifies, and only for its server.
const server = new Server(X.addressOf(base, 'server/a'), key, hexToBytes(X.keyOf(base, 'server/a/x25519')))
const other = X.addressOf(base, 'server/b')
const tickets = Array.from({ length: 20 }, (_, k) => {
  const serial = serialOf(base, `t${k}`)
  const factor = factorOf(base, `t${k}`)
  const { blinded } = blind(server.address, serial, factor)
  const answers = [0, 2, 3].map((i) => ({ issuer: i, answer: issuerAnswer(issuers, i, blinded) }))
  return { serial, ticket: unblind(answers, factor), blinded }
})
check('a ticket verifies for its server', verifyTicket(key, server.address, tickets[0].serial, tickets[0].ticket))
check('and not for another server', !verifyTicket(key, other, tickets[0].serial, tickets[0].ticket))
check('the blinded point is not the ticket', tickets[0].blinded !== tickets[0].ticket)
const twoAnswers = (() => {
  try {
    unblind([0, 1].map((i) => ({ issuer: i, answer: issuerAnswer(issuers, i, tickets[1].blinded) })), factorOf(base, 't1'))
    return false
  } catch {
    return true
  }
})()
check('two issuers cannot make a ticket', twoAnswers)

// Reads, deliveries and a withheld answer fetched from an attester.
const members = [0, 1, 2, 3].map((i) => new Attester(i, X.keyOf(base, `member/${i}`), i !== 3, key, chainId, pool.address))
const head = 10n * X.EPOCH + 2n
const readerSecret = x25519.utils.randomPrivateKey()
const readerKey = toHex(x25519.getPublicKey(readerSecret))
for (const t of tickets.slice(0, 16)) {
  const query = keccak256(toHex(`query/${t.serial}`))
  const res = server.handle({ query, serial: t.serial, ticket: t.ticket, readerKey })
  if (!('ciphertext' in res)) throw new Error('the server refused a good ticket')
  for (const m of members) check(`member ${m.index} takes ${t.serial.slice(0, 8)}`, m.deliver({ server: server.address, serial: t.serial, ticket: t.ticket, ciphertext: res.ciphertext }, head).ok)
  check('the reader decrypts the answer from a member', decrypt(readerSecret, res.serverKey, t.serial, members[1].fetch(t.serial)!) === answerOf(query))
}
check('a spent ticket is refused', 'ok' in server.handle({ query: '0x00', serial: tickets[0].serial, ticket: tickets[0].ticket, readerKey }))

// A batch, its root and paths, and three signatures that recover to their members.
const batch: X.Batch = { server: server.address, epoch: X.epochOf(head), serials: tickets.slice(0, 16).map((t) => t.serial) }
const early = await members[0].signBatch(batch, head)
check('an honest member will not sign before the epoch ends', !isSig(early))
const after = X.epochEnd(batch.epoch) + 1n
const sigs = (await Promise.all(members.map((m) => m.signBatch(batch, after)))).filter(isSig)
check('all four sign the delivered batch', sigs.length === 4)
const digest = X.batchDigest(chainId, pool.address, batch)
for (const s of sigs) check(`member ${s.member}'s signature recovers`, (await recoverAddress({ hash: digest, signature: { r: s.r, s: s.s, v: s.v } })) === pool.members[s.member])
for (let i = 0; i < 16; i++) {
  const path = X.pathOf(batch.serials, i)
  let n = keccak256(batch.serials[i])
  for (let l = 0; l < X.depthOf(16); l++) n = (i >> l) & 1 ? keccak256(`${path[l]}${n.slice(2)}` as Hex) : keccak256(`${n}${path[l].slice(2)}` as Hex)
  if (n !== X.rootOf(batch.serials)) throw new Error(`path ${i}`)
}
check('every serial\'s path leads to the root', true)
check('a batch of one has its leaf as its root', X.rootOf([tickets[0].serial]) === keccak256(tickets[0].serial))

// The honest members refuse a batch repeating a serial, and a refund of a delivered serial; the
// dishonest one signs both, and the pair is what a reporter needs.
const repeat: X.Batch = { server: server.address, epoch: batch.epoch + 1n, serials: [tickets[0].serial] }
const rs = await Promise.all(members.map((m) => m.signBatch(repeat, X.epochEnd(repeat.epoch) + 1n)))
check('only the dishonest member signs a repeated serial', rs.filter(isSig).length === 1 && isSig(rs[3]))
const recipient = X.addressOf(base, 'reader/refund')
const ref = await Promise.all(members.map((m) => m.signRefund({ server: server.address, serial: tickets[1].serial, ticket: tickets[1].ticket, recipient }, after + 5n * X.EPOCH)))
check('only the dishonest member signs a refund of a delivered serial', ref.filter(isSig).length === 1 && isSig(ref[3]))
const w1 = X.slashTwoBatches({ member: 3, reporter: recipient, a: batch, sigA: sigs[3], b: repeat, sigB: rs[3] as X.Sig, serial: tickets[0].serial })
check('a kind-1 slash has 37 words', w1.length === 37)
const w2 = X.slashBatchAndRefund({ member: 3, reporter: recipient, a: batch, sigA: sigs[3], serial: tickets[1].serial, recipient, sigR: ref[3] as X.Sig })
check('a kind-2 slash has 25 words', w2.length === 25)

// A withheld delivery: the refund waits a whole epoch, then three honest members sign it.
const withheld = tickets[17]
const asked = after
// The reader asks every member at once: each starts its own wait when it first hears.
const first = await Promise.all(members.slice(0, 3).map((m) => m.signRefund({ server: server.address, serial: withheld.serial, ticket: withheld.ticket, recipient }, asked)))
check('a refund is not signed in the epoch it is asked', !first.some(isSig))
const later = X.epochEnd(X.epochOf(asked)) + 1n
const signed = await Promise.all(members.slice(0, 3).map((m) => m.signRefund({ server: server.address, serial: withheld.serial, ticket: withheld.ticket, recipient }, later)))
check('three honest members sign the refund an epoch later', signed.every(isSig))
check('then none will take its delivery', !members[0].deliver({ server: server.address, serial: withheld.serial, ticket: withheld.ticket, ciphertext: '0x00' }, later).ok)
console.log(`a member's ticket check: ${(members[0].checkMillis.reduce((a, b) => a + b, 0) / members[0].checkMillis.length).toFixed(1)} ms on average`)
