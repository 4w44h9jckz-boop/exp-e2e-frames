// Experiment 18 (X13), arms 1 to 6 on the test network: a note's opening delivered off chain.
//   1. Invoice: the recipient asks first with a one-time ML-KEM key and a random mailbox tag.
//   2. Push through the pool: the sender has only the recipient's published key; the recipient
//      scans the pool, and also asks the store to detect with an FMD key.
//   3. Push through a blob, on a type-3 carrier.
//   4. Pairwise tags: two more notes after arm 2's first contact, fetched by tag.
//   5. Withheld: never delivered; the sender reclaims after T on the refund branch.
//   6. Late, then the fallback: no spend seen by T1, the sender posts the entry in a blob, the
//      recipient comes back and spends before T.
// Also on chain: a spend whose tNow is later than the registry's clock, refused in VERIFY. Every
// call to the store goes through the transport stand-in at a mean delay of 1 second. Every spend
// is simulated, sent first to a skandha node and then, if it is not mined, to the chain.
//
// usage: X13_DEPLOYMENT=<tag> npx tsx experiments/18-x13-out-of-band-delivery/run.ts <n>-<label>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Hex, bytesToHex, createWalletClient, decodeEventLog, encodeFunctionData, hexToBigInt, http, keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { type Pin, buildSkandha, checkout, loadKey, rpcUrlOf, run, startNode, stopNode, writeConfig } from '../../src/e2e/index.js'
import { sendFrames } from '../../src/exp-frames/deploy.js'
import { type FrameTx, frameReceiptGas, frameReceiptStatus, frameTxHash, hegotaTestnet, makeClient, senderFrame, serializeFrameTx, simulateFrameTx, waitForFrameTxReceipt } from '../../src/exp-frames/frametx/index.js'
import * as B from '../17-x12-ciphertexts-in-blobs/blob.js'
import * as F from './fmd.js'
import * as M from './mailbox.js'
import * as N from './notes.js'
import * as K from './tickets.js'
import * as X from './x13.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const work = join(root, 'work')
const runLabel = process.argv[2]
if (!runLabel || !/^\d+-[a-z0-9-]+$/.test(runLabel)) throw new Error('usage: run.ts <n>-<label>')
mkdirSync(join(here, 'results'), { recursive: true })
mkdirSync(join(root, 'test/fixtures/x13'), { recursive: true })
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8')) as Record<string, Pin>
const { privateKey, address: funder } = loadKey()
const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
const dirty = (await run('git', ['status', '--porcelain', '--', X.DIR, 'src'], { cwd: root })).trim()
if (dirty) throw new Error(`commit the experiment before a recorded run:\n${dirty}`)

const chain = makeClient()
const chainId = BigInt(await chain.getChainId())
const wallet = createWalletClient({ account: privateKeyToAccount(privateKey), chain: hegotaTestnet, transport: http() })
const T0 = Date.now()
const wall = () => +((Date.now() - T0) / 1000).toFixed(3)
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000))
const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n))

// ---- the parties, from PRIVATE_KEY; their secrets are searched for in the record ----

const secrets: bigint[] = []
const fieldSecret = (l: string) => { const x = X.fieldOf(privateKey, l); secrets.push(x); return x }
const skR = fieldSecret('recipient/sk')
const R = { pkR: X.H(skR), d: 60n }
const kemSeed = X.bytesOf(privateKey, 'recipient/kem', 64)
const kemR = N.kemKeygen(kemSeed)
let fmdBytes = 0
const fmdR = F.keygen(() => X.bytesOf(privateKey, `recipient/fmd/${fmdBytes++}`, 32))
fmdR.sk.forEach((x) => secrets.push(x))
const skS = fieldSecret('sender/refund')
const refundS = X.H(skS)
const secretStrings = [privateKey, bytesToHex(kemSeed), ...secrets.map((x) => x.toString(16).padStart(64, '0'))]

const rows: Record<string, unknown>[] = []
const setup: Record<string, unknown>[] = []
const out: Record<string, unknown> = {}
const fixtureTxs: { step: string; hash: Hex; raw: Hex }[] = []

// ---- set-up ----

async function setupTx(what: string, frames: Parameters<typeof sendFrames>[2]) {
  const r = await sendFrames(chain, privateKey, frames, { label: what })
  if (!r?.hash || !r.receipt) throw new Error(`${what}: not mined`)
  const ok = r.receipt.frameReceipts.every((f) => frameReceiptStatus(f) === 1)
  const row = { what, hash: r.hash, block: Number(BigInt(r.receipt.blockNumber)), gasUsed: Number(BigInt(r.receipt.gasUsed)), frames: r.receipt.frameReceipts.map((f) => ({ status: frameReceiptStatus(f), ...frameReceiptGas(f) })), ok }
  setup.push(row)
  if (!ok) throw new Error(`${what}: a frame failed`)
  return row
}
console.log(`deployment ${X.DEPLOYMENT}: registry ${X.registry.address}, verifier ${X.verifier.address}`)
{
  const code = await chain.getCode({ address: X.registry.address })
  if (code && code !== '0x') throw new Error('the registry is already deployed: set X13_DEPLOYMENT to a fresh tag')
  const h = await chain.getCode({ address: X.HASHER })
  if (!h || h === '0x') throw new Error('experiment 06\'s hasher is not on the test network')
}
const firstBlock = (await setupTx('deploy the verifier and the registry', [X.verifier.deploy, X.registry.deploy])).block
await setupTx('the registry\'s float', [senderFrame({ target: X.registry.address, value: 10n ** 16n, execution: 50_000n, state: 0n })])

// The store, its issuers, and tickets bought blindly in advance.
const issuers = K.dealIssuers(X.keyOf(privateKey, 'issuers'))
const storeAddress = X.addressOf(privateKey, 'store')
const store = new M.Store(storeAddress, K.keyHex(issuers))
const url = await store.listen()
const net = new M.Transport(url, 1)
const walletOf = (who: string, n: number) => { const w = new M.Wallet(issuers, storeAddress, X.keyOf(privateKey, `tickets/${who}`), who); w.buy(n); return w }
const ticketsR = walletOf('recipient', 30)
const ticketsS = walletOf('sender', 30)
const ticketsO = walletOf('others', 260)
const issuance = { note: 'issuers saw only blinded points; the store saw serials and signatures; none is equal to another', blindedSeen: 320 }

// The open node, for every spend.
const skandha = await checkout('skandha', pins.skandha, work)
await buildSkandha(skandha)
const stamp = Date.now()
const config = join(work, `x13-${stamp}.json`)
writeConfig(config)
const nodeA = await startNode({ dir: skandha, name: 'A', config, dataDir: join(work, `a-${stamp}`), apiPort: 15337, wsPort: 15437, p2pPort: 15000, log: join(work, `a-${stamp}.frames.jsonl`), out: join(work, `a-${stamp}.out`) })

// ---- the registry's leaves, read back from its events ----

type Leaf = { index: number; leaf: bigint; t0: bigint; kind: 'deposit' | 'spent'; c: bigint }
async function leaves(): Promise<Leaf[]> {
  const logs = await chain.getLogs({ address: X.registry.address, fromBlock: BigInt(firstBlock), toBlock: 'latest' })
  const ls: Leaf[] = []
  for (const l of logs) {
    const e = decodeEventLog({ abi: X.registryAbi, data: l.data, topics: l.topics }) as unknown as { eventName: string; args: Record<string, bigint | Hex> }
    if (e.eventName === 'Deposited') ls.push({ index: Number(e.args.index), c: hexToBigInt(e.args.c as Hex), t0: e.args.t0 as bigint, kind: 'deposit', leaf: 0n })
    if (e.eventName === 'Spent') ls.push({ index: Number(e.args.index), c: hexToBigInt(e.args.outCommitment as Hex), t0: e.args.t0 as bigint, kind: 'spent', leaf: 0n })
  }
  ls.sort((a, b) => a.index - b.index)
  ls.forEach((x, i) => { if (x.index !== i) throw new Error(`leaf ${i} missing`); x.leaf = N.leafOf(x.c, x.t0) })
  return ls
}
const readR = <T>(functionName: string, args: unknown[] = []) => chain.readContract({ address: X.registry.address, abi: X.registryAbi, functionName, args } as never) as Promise<T>

// ---- notes ----

type Note = { label: string; opening: N.Opening; delivered: Uint8Array; h: bigint; c: bigint; index?: number; t0?: bigint; block?: number }
const notes: Record<string, Note> = {}
const nowSec = async () => Number((await chain.getBlock({ blockTag: 'latest' })).timestamp)

// A deposit's insertion writes fresh slots: the first leaf writes all 20 subtree slots, the root,
// its mark, the count and the clock (pass d1 stopped there, its state spilling into execution).
const DEPOSIT_STATE = 24n * 97_920n
async function deposit(label: string, delivered: Uint8Array, opening: N.Opening) {
  const h = N.hOf(delivered)
  const c = N.commitmentOf(opening, R, h)
  const r = await setupTx(`deposit: note ${label}`, [senderFrame({ target: X.registry.address, value: N.DENOM, data: encodeFunctionData({ abi: X.registryAbi, functionName: 'deposit', args: [X.word(c)] }), execution: 1_400_000n, state: DEPOSIT_STATE })])
  const receipt = await chain.getTransactionReceipt({ hash: r.hash as Hex })
  const ev = receipt.logs.map((l) => { try { return decodeEventLog({ abi: X.registryAbi, data: l.data, topics: l.topics }) as unknown as { eventName: string; args: { index: bigint; t0: bigint } } } catch { return undefined } }).find((e) => e?.eventName === 'Deposited')!
  const n: Note = { label, opening, delivered, h, c, index: Number(ev.args.index), t0: ev.args.t0, block: r.block as number }
  if (opening.T < n.t0! + R.d) throw new Error(`${label}: T is below the floor at t0 = ${n.t0}`)
  notes[label] = n
  rows.push({ step: `deposit: note ${label}`, hash: r.hash, block: r.block, gasUsed: r.gasUsed, frames: r.frames, index: n.index, t0: Number(n.t0), T: Number(opening.T), c: X.word(c), h: X.word(h) })
  return n
}
const openingOf = (label: string, T: bigint): N.Opening => ({ value: N.DENOM, n: fieldSecret(`note/${label}/n`), s: fieldSecret(`note/${label}/s`), T, refund: refundS })

// ---- a spend ----

const received: Record<string, number> = {}
async function spend(step: string, note: Note, branch: 0n | 1n, opts: { tNow?: bigint; expect?: 'mined' | 'refused' } = {}) {
  const expect = opts.expect ?? 'mined'
  const ls = await leaves()
  const tree = X.treeFrom(ls.map((l) => l.leaf))
  const p = tree.path(note.index!)
  // The leaf the proof will rebuild must be the one the registry inserted.
  const mine = ls[note.index!]
  const cLocal = N.commitmentOf(note.opening, R, note.h)
  if (mine.c !== note.c || cLocal !== note.c || mine.t0 !== note.t0 || N.leafOf(cLocal, note.t0!) !== mine.leaf) {
    throw new Error(`${step}: leaf ${note.index} differs: event c ${mine.c === note.c}, recomputed c ${cLocal === note.c}, t0 ${mine.t0}/${note.t0}, leaf ${N.leafOf(cLocal, note.t0!) === mine.leaf}`)
  }
  const tNow = opts.tNow ?? (await readR<bigint>('clock'))
  const outInner = fieldSecret(`out/${step}`)
  const outCommitment = X.H(note.opening.value, outInner)
  const nullifier = N.nullifierOf(note.opening)
  const { proof, ms } = await X.prove({
    root: tree.root, nullifier, tNow, outCommitment, value: note.opening.value, pkR: R.pkR, d: R.d, n: note.opening.n, s: note.opening.s, h: note.h, T: note.opening.T,
    refund: note.opening.refund, t0: note.t0!, branch, sk: branch ? skS : skR, outInner, pathElements: p.pathElements, pathIndices: p.pathIndices,
  })
  const w = [tree.root, nullifier, tNow, outCommitment, ...proof]
  const tx = X.spendTx(chainId, w)
  const hash = frameTxHash(tx)
  const raw = serializeFrameTx(tx)
  let sim = await simulateFrameTx(chain, tx)
  for (let i = 0; expect === 'mined' && (!sim.valid || sim.executionStatus !== 'success') && i < 10; i++) { await sleep(6); sim = await simulateFrameTx(chain, tx) }
  const simRow = { valid: sim.valid, violation: sim.violation, executionStatus: sim.executionStatus, frames: sim.frames?.map((f) => ({ gasUsed: Number(BigInt(f.gasUsed)), succeeded: f.succeeded })) }
  const base = { step, note: note.label, branchTruth: Number(branch), tNow: Number(tNow), proveMs: ms, nullifier: X.word(nullifier), outCommitment: X.word(outCommitment), calldataBytes: (tx.frames[1].data.length - 2) / 2 }
  if (expect === 'refused') {
    if (sim.valid) throw new Error(`${step}: expected a refusal, simulation admits it`)
    let answer = 'admitted'
    try { await chain.request({ method: 'eth_sendRawTransaction', params: [raw] } as never) } catch (e) { answer = (e as Error).message.split('\n')[0].slice(0, 200) }
    if (answer === 'admitted') throw new Error(`${step}: the chain admitted what simulation refused`)
    console.log(`${step}: refused (${sim.violation}); RPC: ${answer}`)
    rows.push({ ...base, outcome: 'refused', simulation: simRow, rpc: answer })
    return undefined
  }
  if (!sim.valid || sim.executionStatus !== 'success') throw new Error(`${step}: simulation does not admit it: ${JSON.stringify(simRow)}`)
  // skandha first; then the chain directly if it is not mined.
  let skandhaAnswer = 'admitted'
  try {
    const res = await fetch(rpcUrlOf(nodeA), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }) })
    const body = await res.json()
    skandhaAnswer = body.error ? JSON.stringify(body.error).slice(0, 300) : `admitted: ${body.result}`
  } catch (e) { skandhaAnswer = `unreachable: ${(e as Error).message.slice(0, 200)}` }
  console.log(`${step}: skandha ${skandhaAnswer.slice(0, 160)}`)
  // A refusal means skandha will not relay it: straight to the chain (pass d5 waited on every one).
  let r = skandhaAnswer.startsWith('admitted') ? await waitForFrameTxReceipt(chain, hash, { timeoutMs: 45_000 }).catch(() => undefined) : undefined
  let via = 'skandha'
  if (!r) {
    via = 'chain'
    try { await chain.request({ method: 'eth_sendRawTransaction', params: [raw] } as never) } catch (e) { if (!/known|already/i.test((e as Error).message)) throw e }
    r = await waitForFrameTxReceipt(chain, hash, { timeoutMs: 180_000 })
  }
  const frames = r.frameReceipts.map((f) => ({ status: frameReceiptStatus(f), ...frameReceiptGas(f) }))
  const ok = frames.every((f) => f.status === 1)
  const block = await chain.getBlock({ blockNumber: BigInt(r.blockNumber) })
  const row = { ...base, outcome: ok ? 'mined' : 'mined, a frame failed', hash, block: Number(BigInt(r.blockNumber)), blockTime: Number(block.timestamp), wallAtBlock: wall(), gasUsed: Number(BigInt(r.gasUsed)), frames: frames.map((f) => ({ status: f.status, execution: Number(f.execution), state: Number(f.state) })), skandha: skandhaAnswer, via, simulation: simRow, receivedAt: received[note.label] }
  console.log(`${step}: ${hash} block ${row.block} gasUsed ${row.gasUsed} frames ${frames.map((f) => `${f.status}:${f.execution}+${f.state}s`).join(' / ')} via ${via}`)
  rows.push(row)
  fixtureTxs.push({ step, hash, raw })
  if (!ok) throw new Error(`${step}: a frame failed`)
  return row
}

/** The wallet's spend time: uniform over the window up to `latest`, in wall seconds from now. */
const spendLater = async (latestFromNow: number) => sleep(Math.random() * Math.max(0, latestFromNow))
const WINDOW = 60

// ---- deposits ----

const start = await nowSec()
const invoice = { ek: kemR.ek, tag: bytesToHex(rnd(32)), pkR: R.pkR, d: R.d }
const o1 = openingOf('1-invoice', BigInt(start + 900))
const s1 = N.sealFirst(invoice.ek, o1, rnd(32))
await deposit('1-invoice', s1.entry, o1)
const o2 = openingOf('2-pool', BigInt(start + 900))
const s2 = N.sealFirst(kemR.ek, o2, rnd(32))
await deposit('2-pool', s2.entry, o2)
const o3 = openingOf('3-blob', BigInt(start + 900))
const s3 = N.sealFirst(kemR.ek, o3, rnd(32))
await deposit('3-blob', s3.entry, o3)
const o4 = openingOf('4-pair-1', BigInt(start + 900))
const p4 = N.sealPair(s2.ss, 1, o4)
await deposit('4-pair-1', p4, o4)
const o5 = openingOf('4-pair-2', BigInt(start + 900))
const p5 = N.sealPair(s2.ss, 2, o5)
await deposit('4-pair-2', p5, o5)
const o6 = openingOf('5-withheld', BigInt((await nowSec()) + 150))
const s6 = N.sealFirst(kemR.ek, o6, rnd(32))
await deposit('5-withheld', s6.entry, o6)

// ---- arm 1: invoice ----

await net.call('put', { tag: invoice.tag, bytes: bytesToHex(s1.entry), ticket: ticketsS.next() })
{
  const got = await net.call('get', { tag: invoice.tag, ticket: ticketsR.next() })
  const bytes = (got.messages as Hex[]).map((m) => Uint8Array.from(Buffer.from(m.slice(2), 'hex')))
  const opened = bytes.map((b) => ({ b, o: N.openFirst(kemR.dk, b) })).find((x) => x.o)
  if (!opened) throw new Error('arm 1: nothing opened')
  if (N.commitmentOf(opened.o!.opening, R, N.hOf(opened.b)) !== notes['1-invoice'].c) throw new Error('arm 1: no leaf matches')
  received['1-invoice'] = wall()
}
await spendLater(WINDOW)
await spend('spend: arm 1, invoice, owner branch', notes['1-invoice'], 0n)

// ---- arm 2: push through the pool, scanned and detected ----

{
  const decoys = Array.from({ length: 200 }, () => {
    const other = N.kemKeygen(rnd(64))
    const o = { value: N.DENOM, n: hexToBigInt(keccak256(rnd(32))) % X.FIELD, s: 1n, T: 0n, refund: 0n }
    return { bytes: N.sealFirst(other.ek, o, rnd(32)).entry, flag: F.flagBytes(F.flag(F.keygen(() => rnd(32)).pk, () => rnd(32))) }
  })
  const mine = { bytes: s2.entry, flag: F.flagBytes(F.flag(fmdR.pk, () => rnd(32))) }
  const at = 137
  const all = [...decoys.slice(0, at), mine, ...decoys.slice(at)]
  await Promise.all(all.map((x, i) => net.call('post', { bytes: bytesToHex(x.bytes), flag: bytesToHex(x.flag), ticket: i === at ? ticketsS.next() : ticketsO.next() })))
  const t1 = performance.now()
  const pool = await net.call('since', { cursor: 0, ticket: ticketsR.next() })
  const scanned = (pool.messages as Hex[]).map((m) => Uint8Array.from(Buffer.from(m.slice(2), 'hex')))
  const found = scanned.flatMap((b, i) => (N.openFirst(kemR.dk, b) ? [i] : []))
  const scanMs = performance.now() - t1
  const dsk = F.extract(fmdR.sk, 4)
  const det = await net.call('detect', { cursor: 0, key: dsk.x.map(String), ticket: ticketsR.next() })
  const detected = (det.messages as Hex[]).map((m) => Uint8Array.from(Buffer.from(m.slice(2), 'hex')))
  const foundDetected = detected.flatMap((b, i) => (N.openFirst(kemR.dk, b) ? [(det.indices as number[])[i]] : []))
  out.arm2 = { pool: scanned.length, found, scanMsPerEntry: +(scanMs / scanned.length).toFixed(3), detectKeys: 4, flagged: (det.indices as number[]).length, foundAmongFlagged: foundDetected }
  console.log(`arm 2: pool ${scanned.length}, found ${found}; FMD n=4 flagged ${(det.indices as number[]).length}, ours among them ${foundDetected}`)
  if (found.length !== 1 || !foundDetected.length) throw new Error('arm 2: not found')
  received['2-pool'] = wall()
}
await spendLater(WINDOW)
await spend('spend: arm 2, pool, owner branch', notes['2-pool'], 0n)

// ---- arm 3: push through a blob ----

async function carrier(step: string, entries: Uint8Array[]) {
  const blob = B.packBlob(B.KIND.N, entries)
  const sidecar = B.sidecarOf([blob])
  const vh = B.versionedHashOf(sidecar.commitments[0])
  const account = privateKeyToAccount(privateKey)
  const nonce = await chain.getTransactionCount({ address: funder, blockTag: 'pending' })
  const signed = await account.signTransaction({ type: 'eip4844', chainId: Number(chainId), nonce, to: funder, value: 0n, data: '0x', gas: 50_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 1n, maxFeePerBlobGas: 100n, blobVersionedHashes: [vh] })
  const hash = (await chain.request({ method: 'eth_sendRawTransaction', params: [B.blobTxWithBlobs(signed, sidecar)] } as never)) as Hex
  const r = await chain.waitForTransactionReceipt({ hash, timeout: 180_000 })
  rows.push({ step, hash, block: Number(r.blockNumber), gasUsed: Number(r.gasUsed), blobGasUsed: r.blobGasUsed ? Number(r.blobGasUsed) : undefined, vh, entries: entries.length })
  console.log(`${step}: ${hash} block ${Number(r.blockNumber)}`)
  return { blob, vh, entries }
}
const decoyEntries = (k: number) => Array.from({ length: k }, () => N.sealFirst(N.kemKeygen(rnd(64)).ek, { value: N.DENOM, n: 1n, s: 1n, T: 0n, refund: 0n }, rnd(32)).entry)
const blob3 = await carrier('blob: note 3 among 96 others on a type-3 carrier', [...decoyEntries(40), s3.entry, ...decoyEntries(56)])
{
  // The recipient reads the blob from the run's copy, checked against its versioned hash.
  if (B.versionedHashOf(B.commitmentOf(blob3.blob)) !== blob3.vh) throw new Error('arm 3: the copy does not match')
  const found = B.unpackBlob(blob3.blob).entries.flatMap((e, i) => (N.openFirst(kemR.dk, e) ? [i] : []))
  out.arm3 = { entries: blob3.entries.length, found }
  if (found.join() !== '40') throw new Error(`arm 3: found ${found}`)
  received['3-blob'] = wall()
}
await spendLater(WINDOW)
await spend('spend: arm 3, blob, owner branch', notes['3-blob'], 0n)

// ---- arm 4: pairwise tags ----

await net.call('put', { tag: bytesToHex(N.pairTag(s2.ss, 1)), bytes: bytesToHex(p4), ticket: ticketsS.next() })
await net.call('put', { tag: bytesToHex(N.pairTag(s2.ss, 2)), bytes: bytesToHex(p5), ticket: ticketsS.next() })
{
  // The recipient's shared secret comes from its own decapsulation of arm 2's entry.
  const ss = N.openFirst(kemR.dk, s2.entry)!.ss
  for (const [k, label] of [[1, '4-pair-1'], [2, '4-pair-2']] as const) {
    const got = await net.call('get', { tag: bytesToHex(N.pairTag(ss, k)), ticket: ticketsR.next() })
    const b = Uint8Array.from(Buffer.from((got.messages as Hex[])[0].slice(2), 'hex'))
    const o = N.openPair(ss, k, b)
    if (!o || N.commitmentOf(o, R, N.hOf(b)) !== notes[label].c) throw new Error(`arm 4: note ${k} does not match`)
    received[label] = wall()
    out[`arm4-${k}`] = { bytes: b.length, decapsulations: 0 }
  }
}
await spendLater(WINDOW)
await spend('spend: arm 4, pairwise note 1, owner branch', notes['4-pair-1'], 0n)
await spend('spend: arm 4, pairwise note 2, owner branch', notes['4-pair-2'], 0n)

// ---- arm 6: late, then the fallback; first, a spend with tNow past the registry's clock ----

// Deposited here, so that its T is counted from the arm and not from the start (pass d5 stopped
// with T passed before the arm began).
const t7 = (await nowSec()) + 300
const o7 = openingOf('6-late', BigInt(t7))
const s7 = N.sealFirst(kemR.ek, o7, rnd(32))
await deposit('6-late', s7.entry, o7)
const T1 = t7 - 150
{
  const clock = await readR<bigint>('clock')
  await spend('refused: tNow later than the registry\'s clock', notes['6-late'], 0n, { tNow: clock + 3600n, expect: 'refused' })
}
while ((await nowSec()) < T1) await sleep(10)
{
  const ls = await chain.getLogs({ address: X.registry.address, fromBlock: BigInt(firstBlock), toBlock: 'latest' })
  const spent = ls.some((l) => { try { const e = decodeEventLog({ abi: X.registryAbi, data: l.data, topics: l.topics }) as unknown as { eventName: string; args: { nullifier: bigint } }; return e.eventName === 'Spent' && e.args.nullifier === N.nullifierOf(o7) } catch { return false } })
  if (spent) throw new Error('arm 6: the note was spent before T1')
  out.arm6 = { T1, T: t7, spentByT1: false }
}
const blob6 = await carrier('fallback: the sender posts note 6 in a blob at T1', [...decoyEntries(20), s7.entry, ...decoyEntries(10)])
await sleep(20)
{
  if (B.versionedHashOf(B.commitmentOf(blob6.blob)) !== blob6.vh) throw new Error('arm 6: the copy does not match')
  const found = B.unpackBlob(blob6.blob).entries.flatMap((e, i) => (N.openFirst(kemR.dk, e) ? [i] : []))
  if (found.join() !== '20') throw new Error(`arm 6: found ${found}`)
  received['6-late'] = wall()
}
const late = await spend('spend: arm 6, the late recipient from the fallback, owner branch', notes['6-late'], 0n)
if (late && late.blockTime > t7) throw new Error('arm 6: spent after T')

// ---- arm 5: withheld, then reclaimed ----

while ((await nowSec()) < Number(o6.T)) await sleep(10)
if ((await readR<bigint>('clock')) < o6.T) await setupTx('tick: the registry\'s clock past T', [senderFrame({ target: X.registry.address, data: encodeFunctionData({ abi: X.registryAbi, functionName: 'tick' }), execution: 40_000n, state: 0n })])
await spend('spend: arm 5, the sender reclaims after T, refund branch', notes['5-withheld'], 1n)
await net.call('put', { tag: bytesToHex(rnd(32)), bytes: bytesToHex(s6.entry), ticket: ticketsS.next() })
await spend('refused: the recipient spends the reclaimed note', notes['5-withheld'], 0n, { expect: 'refused' })

await stopNode(nodeA.child)
store.close()

// ---- the record ----

const record = {
  experiment: 18, run: runLabel, deployment: X.DEPLOYMENT, repoCommit, chainId: Number(chainId), funder,
  contracts: { registry: X.registry.address, verifier: X.verifier.address, hasher: X.HASHER },
  pins, setup, rows, ...out, received,
  store: { address: storeAddress, log: store.log, fields: [...new Set(store.log.flatMap((e) => Object.keys(e)))] },
  transport: { meanSeconds: 1, cover: 0, delays: net.delays.map((d) => +d.toFixed(3)) },
  tickets: issuance, recipient: { pkR: X.word(R.pkR), d: Number(R.d), fmdPk: fmdR.pk.map((p) => bytesToHex(p)) },
}
const fixture = {
  chainId: Number(chainId), registry: X.registry.address, verifier: X.verifier.address, firstBlock,
  notes: Object.values(notes).map((n) => ({ label: n.label, c: X.word(n.c), h: X.word(n.h), index: n.index, t0: Number(n.t0), delivered: bytesToHex(n.delivered) })),
  blobs: { arm3: { vh: blob3.vh, entries: blob3.entries.map((e) => bytesToHex(e)) }, arm6: { vh: blob6.vh, entries: blob6.entries.map((e) => bytesToHex(e)) } },
  transactions: fixtureTxs,
}
for (const [name, body] of [['record', JSON.stringify(record, (_, v) => (typeof v === 'bigint' ? v.toString() : v))], ['fixture', JSON.stringify(fixture)]] as const) {
  for (const s of secretStrings) {
    const bare = s.replace(/^0x/, '').toLowerCase()
    if (bare.length >= 32 && body.toLowerCase().includes(bare)) throw new Error(`the ${name} contains a secret; not written`)
  }
}
writeFileSync(join(here, 'results', `${runLabel}.json`), JSON.stringify(record, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n')
writeFileSync(join(root, 'test/fixtures/x13', `${runLabel}.json`), JSON.stringify(fixture, null, 1) + '\n')
console.log(`recorded results/${runLabel}.json and test/fixtures/x13/${runLabel}.json`)
process.exit(0)
