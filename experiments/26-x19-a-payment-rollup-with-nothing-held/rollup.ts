// Experiment 26 (X19): the rollup's transactions, built as an aggregator, a taker or a member's
// device would build them, and the off-chain state every party keeps: the public tree, rebuilt from
// the rollup's own events, and each member's private head.
//
// Every transaction's sender and payer is the rollup (amendment 1). A channel's members appear only
// as leanSPHINCS dependencies, and a user's proof as one leanSTARK dependency.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Address, type Hex, bytesToHex, concatHex, hexToBytes, keccak256, pad, toHex } from 'viem'
import { compileYul } from '../../src/exp-frames/contracts.js'
import { Approve, type Frame, type FrameTx, NEW_ACCOUNT_STATE_GAS, STORAGE_SET_STATE_GAS, senderFrame, verifyFrame } from '../../src/exp-frames/frametx/index.js'
import * as L from '../19-x14-hash-based-stealth-addresses-under-8288/lean.js'
import * as X14 from '../19-x14-hash-based-stealth-addresses-under-8288/x14.js'
import * as X from './x19.js'

const here = new URL('.', import.meta.url).pathname
const DIR = join(here, 'contracts')

export const SEL = { apply: '0xdb595b3b', queue: '0xe10d29ee', freeze: '0x62a5af3b', claim: '0x4e71d92d', backup: '0x50a9e127' } as const
export const TOPIC = {
  Transfer: '0xf7a5a6b409bb583bd3dbc6acbef7da6c3b7748312d8281c5fddb5ab291415985',
  Queued: '0x720b5ebc92a2846490e50e7f8308bc6f14952c32e34ac503fb59f33135e09f2b',
  Frozen: '0x3e488e247bd383c586f4fc0350fed312fc2af4b1012529d2252ed33efd8fe631',
  Claimed: '0xd9cb1e2714d65a111c0f20f060176ad657496bd47a3de04ec7c3d4ca232112ac',
  Backup: '0x81b53c490562904dc127060d5eacc6e9ac7019c1be55a1439a496fe00a9a5caf',
} as const
export const K = 4
/** The rollup's address at genesis: no key derives it. */
export const ROLLUP = '0x0000000000000000000000000000000000019019' as Address

/** The rollup's runtime code, compiled from its "runtime" object alone, then the program's key. */
export function runtimeCode(vk: Hex): Hex {
  const src = readFileSync(join(DIR, 'Rollup.yul'), 'utf8')
  const start = src.indexOf('object "runtime" {')
  let depth = 0
  let end = -1
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  const file = join(here, '..', '..', 'work', 'x19-rollup-runtime.yul')
  writeFileSync(file, src.slice(start, end))
  return concatHex([compileYul(file), vk])
}

export const word = (x: bigint | number): Hex => pad(toHex(BigInt(x)), { size: 32 })
export const mapslot = (key: Hex, tag: number): Hex => keccak256(concatHex([key, word(tag)]))
const tagWord = (s: string): Hex => word(BigInt(`0x${Buffer.from(s).toString('hex')}`))
export const tagged = (s: string, x: Hex): Hex => keccak256(concatHex([tagWord(s), x]))
export const khOf = (key0: Hex, key1: Hex, recipient: Address): Hex => keccak256(concatHex([key0, key1, pad(recipient, { size: 32 })]))

// ---- the public tree, as every party rebuilds it ----

export class Tree {
  leaves: Hex[]
  constructor(leaves: Hex[]) { this.leaves = [...leaves] }
  private t() { return L.treeOf(this.leaves.map((l) => hexToBytes(l))) }
  root(): Hex { return bytesToHex(this.t().root) }
  path(i: number): Hex[] { return this.t().path(i).sib.map((s) => bytesToHex(s)) }
}

// ---- a member's device: its seed, its keys and its channel's private head ----

export type Member = { seed: Uint8Array; key: Hex }
export type Head = { chan: number; balance: bigint; salt: Hex; members: [Member, Member]; recipient: Address }
export const randomWord = (): Hex => bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
export const commitOf = (balance: bigint, salt: Hex): Hex => X.H(X.B(balance), salt)
export const leafOf = (h: Head): Hex => X.H(khOf(h.members[0].key, h.members[1].key, h.recipient), commitOf(h.balance, h.salt))

/** What a member hands an aggregator: the transfer's public fields, both signatures, the proof. */
export type Handed = {
  chan: number; to: number; c0: Hex; c1: Hex; amountCommit: Hex; fee: bigint; expiry: bigint; nullifier: Hex
  key0: Hex; key1: Hex; recipient: Address; T: Hex; D: Hex
  signatures: [L.Signed, L.Signed]; proofFile: string
  proved: { cycles: number; proveMs: number[]; proofBytes: number; peakRssBytes: number }
}

/** The member's side of a transfer: its own proof over its own witness, and both members' signatures. */
export function makeTransfer(h: Head, o: { to: number; amount: bigint; fee: bigint; expiry: bigint; program: string; proofFile: string; signer?: (m: Uint8Array, i: number) => L.Signed; nullifier?: Hex }) {
  const kh = khOf(h.members[0].key, h.members[1].key, h.recipient)
  const t: X.Transfer = {
    kh, balance: h.balance, amount: o.amount, fee: o.fee, s0: h.salt, s1: randomWord(), r: randomWord(),
    chan: word(h.chan), to: word(o.to), expiry: word(o.expiry), nullifier: o.nullifier ?? randomWord(),
  }
  const pub = X.publicOf(t)
  const proved = X.proveTransfer(o.program, X.inputOf(t, { proofOut: o.proofFile }), 1)
  if ('error' in proved) throw new Error(`the member's proof was refused: ${proved.error}`)
  const T = hexToBytes(pub.transferLeaf)
  const sign = o.signer ?? ((m: Uint8Array, i: number) => L.sign(h.members[i].seed, m))
  const handed: Handed = {
    chan: h.chan, to: o.to, c0: pub.c0, c1: pub.c1, amountCommit: pub.amountCommit, fee: o.fee, expiry: o.expiry, nullifier: t.nullifier,
    key0: h.members[0].key, key1: h.members[1].key, recipient: h.recipient, T: pub.transferLeaf, D: pub.D,
    signatures: [sign(T, 0), sign(T, 1)], proofFile: o.proofFile,
    proved: { cycles: proved.cycles, proveMs: proved.proveMs, proofBytes: proved.proofBytes, peakRssBytes: proved.peakRssBytes },
  }
  // What stays on the device: the new head.
  const next: Head = { ...h, balance: pub.newBalance, salt: t.s1 }
  return { handed, next, newLeaf: pub.newLeaf, oldLeaf: pub.oldLeaf }
}

// ---- the transactions ----

export const LIMITS = { verify: 50_000n, sender: 150_000n, senderState: 300_000n }

const head = (sel: Hex, h: { key0: Hex; key1: Hex; recipient: Address; chan: number; which: number }) =>
  concatHex([sel, h.key0, h.key1, pad(h.recipient, { size: 32 }), word(h.chan), word(h.which)])

function tx(chainId: bigint, nonceKey: Hex, triples: Hex, data: Hex, blobs: Hex[] = []): FrameTx {
  const frames: Frame[] = [
    verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, execution: LIMITS.verify, state: STORAGE_SET_STATE_GAS }),
    X14.depFrame(triples),
    senderFrame({ target: ROLLUP, data, execution: LIMITS.sender, state: LIMITS.senderState }),
  ]
  return { chainId, nonceKeys: [BigInt(nonceKey)], nonceSeq: 0n, sender: ROLLUP, frames, signatures: [], fees: blobs.length ? { ...X14.FEES, maxFeePerBlobGas: 100n } : X14.FEES, blobVersionedHashes: blobs }
}

/** The most a transaction can cost, which the fee must cover: every limit and the intrinsic cost. */
export function maxCostOf(t: FrameTx, intrinsic = 100_000n): bigint {
  const limits = t.frames.reduce((a, f) => a + f.limits.execution + f.limits.state, 0n)
  return (limits + intrinsic) * t.fees.maxFeePerGas
}

const transferBody = (x: Handed) => concatHex([x.c0, x.c1, word(x.to), x.amountCommit, word(x.fee), word(x.expiry), x.nullifier])

/** An aggregator's block: one transfer (amendment 1), with its path against the current root. */
export function applyTx(chainId: bigint, x: Handed, path: Hex[], feeTo: Address, vk: Hex, o: { key1?: Hex } = {}): FrameTx {
  const key1 = o.key1 ?? x.key1
  const triples = concatHex([
    X14.triple(X14.LEANSPHINCS_SCHEME, x.T, x.key0), X14.triple(X14.LEANSPHINCS_SCHEME, x.T, key1), X14.triple(X14.LEANSTARK_SCHEME, x.D, vk),
  ])
  const data = concatHex([head(SEL.apply as Hex, { ...x, which: 0 }), transferBody(x), pad(feeTo, { size: 32 }), ...path])
  return tx(chainId, x.nullifier, triples, data)
}

/** A member queues its own signed leaf, for any block to have to include (amendment 1). */
export function queueTx(chainId: bigint, x: Handed): FrameTx {
  const triples = concatHex([X14.triple(X14.LEANSPHINCS_SCHEME, x.T, x.key0), X14.triple(X14.LEANSPHINCS_SCHEME, x.T, x.key1)])
  const data = concatHex([head(SEL.queue as Hex, { ...x, which: 0 }), transferBody(x), word(0)])
  return tx(chainId, tagged('x19/queue', x.nullifier), triples, data)
}

export const freezeMessage = (chan: number): Hex => keccak256(concatHex([tagWord('x19/freeze'), pad(ROLLUP, { size: 32 }), word(chan)]))
export function freezeTx(chainId: bigint, h: Head, which: number): FrameTx {
  const key = h.members[which].key
  const triples = X14.triple(X14.LEANSPHINCS_SCHEME, freezeMessage(h.chan), key)
  const data = head(SEL.freeze as Hex, { key0: h.members[0].key, key1: h.members[1].key, recipient: h.recipient, chan: h.chan, which })
  return tx(chainId, tagged('x19/freeze', word(h.chan)), triples, data)
}

export const claimMessage = (chan: number, takerTo: Address, takerFee: bigint): Hex =>
  keccak256(concatHex([tagWord('x19/claim'), pad(ROLLUP, { size: 32 }), word(chan), pad(takerTo, { size: 32 }), word(takerFee)]))
export function claimTx(chainId: bigint, h: Head, which: number, takerTo: Address, takerFee: bigint, path: Hex[]): FrameTx {
  const key = h.members[which].key
  const triples = X14.triple(X14.LEANSPHINCS_SCHEME, claimMessage(h.chan, takerTo, takerFee), key)
  const data = concatHex([
    head(SEL.claim as Hex, { key0: h.members[0].key, key1: h.members[1].key, recipient: h.recipient, chan: h.chan, which }),
    word(h.balance), h.salt, commitOf(h.balance, h.salt), pad(takerTo, { size: 32 }), word(takerFee), ...path,
  ])
  return tx(chainId, tagged('x19/claim', word(h.chan)), triples, data)
}

export function backupTx(chainId: bigint, h: Head, which: number, versionedHash: Hex, blockCount: bigint): FrameTx {
  const key = h.members[which].key
  const triples = X14.triple(X14.LEANSPHINCS_SCHEME, versionedHash, key)
  const data = head(SEL.backup as Hex, { key0: h.members[0].key, key1: h.members[1].key, recipient: h.recipient, chan: h.chan, which })
  const nonceKey = keccak256(concatHex([tagWord('x19/backup'), word(h.chan), word(blockCount)]))
  return tx(chainId, nonceKey, triples, data, [versionedHash])
}

/** The members' signatures on T, handed to the local chain's builder before any transaction that
 * carries their triples is sent: a block whose dependency has no witness cannot be proved, and the
 * patched builder rebuilds it without end (run 1). */
export function putSignatures(chain: { putSphincsWitness: (s: number, d: Hex, k: Hex, w: L.Signed) => string }, x: Handed) {
  chain.putSphincsWitness(0x10, x.T, x.key0, x.signatures[0])
  chain.putSphincsWitness(0x10, x.T, x.key1, x.signatures[1])
}

/** The witnesses a block's dependencies need, handed to the local chain's builder before sending. */
export function putWitnesses(chain: { putSphincsWitness: (s: number, d: Hex, k: Hex, w: L.Signed) => string; putStarkWitness: (d: Hex, k: Hex, p: Uint8Array) => string }, x: Handed, vk: Hex) {
  chain.putSphincsWitness(0x10, x.T, x.key0, x.signatures[0])
  chain.putSphincsWitness(0x10, x.T, x.key1, x.signatures[1])
  chain.putStarkWitness(x.D, vk, readFileSync(x.proofFile))
}
