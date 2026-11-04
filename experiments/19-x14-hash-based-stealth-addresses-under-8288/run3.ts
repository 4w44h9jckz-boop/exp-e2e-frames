// Experiment 19 (X14), run 3 on the test network (pre-registered in the README): the shared keys of
// run 2's conflict check removed, EIP-8288 modelled.
//   v1d  two version 1 payments deployed by the payer itself, a contract-creation transaction and
//        an announcement each, no factory; both accounts spent.
//   v5p  version 5's tree in Pool6, its funds split across four pots: four deposits, and four
//        withdrawals whose nullifiers name pots so that two share a pot and the others do not.
// Every proof is made and verified off chain by prover/ before its transaction is sent. Frame
// transactions are simulated, sent to a skandha node at its pin, then to the chain.
//
// usage: X14_DEPLOYMENT=<tag> npx tsx experiments/19-x14-hash-based-stealth-addresses-under-8288/run3.ts <n>-<label>
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256 } from '@noble/hashes/sha2'
import { keccak_256 } from '@noble/hashes/sha3'
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js'
import { type Address, type Hex, bytesToHex, createWalletClient, encodeFunctionData, getContractAddress, http, numberToHex } from 'viem'
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts'
import { type Pin, buildSkandha, checkout, loadKey, rpcUrlOf, run, startNode, stopNode, writeConfig } from '../../src/e2e/index.js'
import { sendFrames } from '../../src/exp-frames/deploy.js'
import { type FrameTx, hegotaTestnet, frameReceiptGas, frameReceiptStatus, frameTxHash, getNonceSeq, makeClient, senderFrame, serializeFrameTx, simulateFrameTx, waitForFrameTxReceipt } from '../../src/exp-frames/frametx/index.js'
import * as X12 from '../17-x12-ciphertexts-in-blobs/x12.js'
import * as L from './lean.js'
import * as X from './x14.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const work = join(root, 'work')
const runLabel = process.argv[2]
if (!runLabel) throw new Error('usage: run3.ts <n>-<label>')
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8')) as Record<string, Pin>
const { privateKey, address: funder } = loadKey()
const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
const dirty = (await run('git', ['status', '--porcelain', '--', X.DIR, 'src'], { cwd: root })).trim()
if (dirty) console.log(`note: uncommitted changes under ${X.DIR} or src/:\n${dirty}`)
const chain = makeClient()
const chainId = BigInt(await chain.getChainId())
const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n))
const fresh = (l: string): Address => privateKeyToAddress(X.keyOf(privateKey, `fresh/${l}`))
const secrets: string[] = [privateKey]
const secretBytes = (l: string, n = 32) => { const b = X.bytesOf(privateKey, l, n); secrets.push(bytesToHex(b)); return b }
const rows: Record<string, unknown>[] = []
const setup: Record<string, unknown>[] = []
const out: Record<string, unknown> = {}
const txs: { step: string; hash: Hex; raw: Hex }[] = []

async function setupTx(what: string, frames: Parameters<typeof sendFrames>[2]) {
  const r = await sendFrames(chain, privateKey, frames, { label: what })
  if (!r?.hash || !r.receipt) throw new Error(`${what}: not mined`)
  const ok = r.receipt.frameReceipts.every((f) => frameReceiptStatus(f) === 1)
  const row = { what, hash: r.hash, block: Number(BigInt(r.receipt.blockNumber)), gasUsed: Number(BigInt(r.receipt.gasUsed)), frames: r.receipt.frameReceipts.map((f) => ({ status: frameReceiptStatus(f), ...frameReceiptGas(f) })), ok }
  setup.push(row)
  if (!ok) throw new Error(`${what}: a frame failed`)
  return row
}
const wallet = createWalletClient({ account: privateKeyToAccount(privateKey), chain: hegotaTestnet, transport: http() })
console.log(`deployment ${X.DEPLOYMENT}: pool6 ${X.pool6.address}, pots ${X.pots.map((p) => p.address).join(' ')}`)
const existing = await chain.getCode({ address: X.pool6.address })
if (existing && existing !== '0x') throw new Error('already deployed: set X14_DEPLOYMENT to a fresh tag')
// One frame transaction: the pool, its four pots, and setPots in the frame after, so nobody else can.
const firstBlock = (await setupTx('deploy Pool6 and its four pots, and set them', [X.pool6.deploy, ...X.pots.map((p) => p.deploy), senderFrame({ target: X.pool6.address, data: encodeFunctionData({ abi: X.pool6Abi, functionName: 'setPots', args: [X.pots.map((p) => p.address) as [Address, Address, Address, Address]] }), execution: 200_000n, state: 4n * 97_920n })])).block
// A float in each pot: a note is withdrawn from the pot its nullifier names, not the one its deposit funded.
await setupTx('a float in each pot', X.pots.map((p) => senderFrame({ target: p.address, value: 2n * X.DENOM, execution: 50_000n, state: 0n })))

const skandha = await checkout('skandha', pins.skandha, work)
await buildSkandha(skandha)
const stamp = Date.now()
const config = join(work, `x14-${stamp}.json`)
writeConfig(config)
const nodeA = await startNode({ dir: skandha, name: 'A', config, dataDir: join(work, `a-${stamp}`), apiPort: 15337, wsPort: 15437, p2pPort: 15000, log: join(work, `a-${stamp}.frames.jsonl`), out: join(work, `a-${stamp}.out`) })

/** Simulate, then skandha, then the chain, resending while the chain does not know it (run 1, d2). */
async function frameStep(step: string, tx: FrameTx, extra: Record<string, unknown> = {}) {
  let sim = await simulateFrameTx(chain, tx)
  for (let i = 0; (!sim.valid || sim.executionStatus !== 'success') && i < 10; i++) { await new Promise((r) => setTimeout(r, 6_000)); sim = await simulateFrameTx(chain, tx) }
  const simRow = { valid: sim.valid, violation: sim.violation, executionStatus: sim.executionStatus }
  if (!sim.valid || sim.executionStatus !== 'success') throw new Error(`${step}: simulation does not admit it: ${JSON.stringify(simRow)}`)
  const raw = serializeFrameTx(tx)
  const hash = frameTxHash(tx)
  let skandhaAnswer = 'admitted'
  try {
    const res = await fetch(rpcUrlOf(nodeA), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }) })
    const body = await res.json()
    skandhaAnswer = body.error ? JSON.stringify(body.error).slice(0, 300) : `admitted: ${body.result}`
  } catch (e) { skandhaAnswer = `unreachable: ${(e as Error).message.slice(0, 200)}` }
  let resends = 0
  let r: Awaited<ReturnType<typeof waitForFrameTxReceipt>> | undefined
  for (let attempt = 0; attempt < 4 && !r; attempt++) {
    try { await chain.request({ method: 'eth_sendRawTransaction', params: [raw] } as never) } catch (e) { if (!/known|already/i.test((e as Error).message)) throw e }
    if (attempt) resends++
    r = await waitForFrameTxReceipt(chain, hash, { timeoutMs: 60_000 }).catch(() => undefined)
  }
  if (!r) throw new Error(`${step}: not mined after ${resends} resends`)
  const frames = r.frameReceipts.map((f) => ({ status: frameReceiptStatus(f), ...frameReceiptGas(f) }))
  const ok = frames.every((f) => f.status === 1)
  const calldataBytes = tx.frames.reduce((n, f) => n + (f.data.length - 2) / 2, 0)
  const row = { step, outcome: ok ? 'mined' : 'mined, a frame failed', hash, block: Number(BigInt(r.blockNumber)), gasUsed: Number(BigInt(r.gasUsed)), frames: frames.map((f) => ({ status: f.status, execution: Number(f.execution), state: Number(f.state) })), calldataBytes, skandha: skandhaAnswer, resends, ...extra }
  console.log(`${step}: ${hash} block ${row.block} gasUsed ${row.gasUsed} frames ${frames.map((f) => `${f.status}:${f.execution}+${f.state}s`).join(' / ')}`)
  rows.push(row)
  txs.push({ step, hash, raw })
  if (!ok) throw new Error(`${step}: a frame failed`)
  return row
}

// ---- the recipient: an ML-KEM key for announcements and version 1's spending key ----

const kem = ml_kem768.keygen(secretBytes('recipient/kem', 64))
const k = secretBytes('recipient/k')
const DS_R = new TextEncoder().encode('exp-e2e-frames/19/r')
const DS_TAG = new TextEncoder().encode('exp-e2e-frames/19/view-tag')
function encapsulate() {
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(kem.publicKey, rnd(32))
  return { ct: cipherText, r: keccak_256(Buffer.concat([DS_R, sharedSecret])), viewTag: sha256(Buffer.concat([DS_TAG, sharedSecret]))[0] }
}
const AMOUNT = X.DENOM
const FUND = 2n * X.DENOM
const bytes = (h: Hex) => Buffer.from(h.slice(2), 'hex')

async function eoaStep(step: string, hash: Hex, extra: Record<string, unknown> = {}) {
  const r = await chain.waitForTransactionReceipt({ hash, timeout: 180_000 })
  const row = { step, outcome: r.status === 'success' ? 'mined' : 'reverted', hash, block: Number(r.blockNumber), gasUsed: Number(r.gasUsed), ...extra }
  console.log(`${step}: ${hash} block ${row.block} gasUsed ${row.gasUsed}`)
  rows.push(row)
  if (r.status !== 'success') throw new Error(`${step}: reverted`)
  return row
}

// ---- v1d: payments deployed by the payer, no factory ----

const K = keccak_256(Buffer.concat([Buffer.from(k), Buffer.from(L.TAG_KEY)]))
const v1d: { account: Address; r: Uint8Array; C: Hex; gas: number }[] = []
for (const label of ['first', 'second']) {
  const e = encapsulate()
  secrets.push(bytesToHex(e.r))
  const C = bytesToHex(keccak_256(Buffer.concat([Buffer.from(K), Buffer.from(e.r)])))
  const nonce = await chain.getTransactionCount({ address: funder, blockTag: 'pending' })
  const account = getContractAddress({ from: funder, nonce: BigInt(nonce) })
  // The creation transaction: Stealth's initcode with version 1's words, the funding as its value.
  const create = await eoaStep(`v1d: pay, ${label}: a creation transaction from the payer`, await wallet.sendTransaction({ data: X.concatInitcode(X.stealthCode, [X.word(1n), C, X.VK1]), value: FUND, gas: 2_500_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 1n } as never), { account })
  const announce = await eoaStep(`v1d: announce, ${label}`, await wallet.writeContract({ address: X12.SINGLETON, abi: X12.singletonAbi, functionName: 'announce', args: [6n, account, bytesToHex(e.ct), numberToHex(e.viewTag, { size: 1 })], gas: 200_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 1n } as never), { account })
  const code = await chain.getCode({ address: account })
  if (!code || code.slice(-128, -64) !== C.slice(2)) throw new Error(`v1d ${label}: the account's code does not carry C`)
  v1d.push({ account, r: e.r, C, gas: create.gasUsed + announce.gasUsed })
}
for (const [i, a] of v1d.entries()) {
  const destination = fresh(`v1d/${i}`)
  const nonce = await getNonceSeq(chain, a.account, [0n])
  const m = X.messageOf(a.account, nonce, destination, AMOUNT)
  const w = L.v1(k, a.r, bytes(m))
  if (bytesToHex(w.C) !== a.C) throw new Error('v1d: C differs')
  const proof = L.prove('v1_preimage', w.input, 0)
  if (!proof.verified) throw new Error('v1d: the proof does not verify')
  const data = `0x${bytesToHex(w.T).slice(2)}${X.triple(X.LEANSTARK_SCHEME, bytesToHex(w.D), X.VK1).slice(2)}` as Hex
  await frameStep(`v1d: the ${i === 0 ? 'first' : 'second'} account spends`, X.spendTx(chainId, a.account, nonce, data, destination, AMOUNT), { version: 1, declaredGas: X.LEANSTARK_VERIFICATION_GAS, proof: { cycles: proof.cycles, proofBytes: proof.proofBytes } })
}
out.v1dPaymentGas = v1d.map((a) => a.gas)

// ---- v5p: four deposits, four withdrawals from the pots their nullifiers name ----

// Notes drawn from PRIVATE_KEY and a label until two share a pot and two others each have their own.
const notes: { j: number; ns: Uint8Array; s: Uint8Array; nf: Hex; pot: number }[] = []
for (let j = 0; notes.length < 4; j++) {
  const ns = X.bytesOf(privateKey, `v5p/note/${j}/ns`, 32)
  const s = X.bytesOf(privateKey, `v5p/note/${j}/s`, 32)
  const nf = bytesToHex(L.nullifierHashOf(ns))
  const pot = X.potOf(nf)
  const counts = [0, 0, 0, 0]
  for (const n of notes) counts[n.pot]++
  const shared = counts.findIndex((c) => c === 2)
  const ok = notes.length < 2 ? (notes.length === 0 || pot === notes[0].pot) : counts[pot] === 0 && shared >= 0
  if (!ok) continue
  secrets.push(bytesToHex(ns), bytesToHex(s))
  notes.push({ j, ns, s, nf, pot })
}
out.notePots = notes.map((n) => n.pot)
console.log(`notes: pots ${notes.map((n) => n.pot).join(', ')}`)
const DEPOSIT_GAS = 23n * 97_920n + 600_000n
const leaves: Uint8Array[] = []
for (const [i, n] of notes.entries()) {
  const c = L.leafOf(n.ns, n.s)
  await eoaStep(`v5p: deposit ${i}`, await wallet.writeContract({ address: X.pool6.address, abi: X.pool6Abi, functionName: 'deposit', args: [bytesToHex(c)], value: X.DENOM, gas: DEPOSIT_GAS, maxFeePerGas: 100n, maxPriorityFeePerGas: 1n } as never), { pot: i % X.POTS })
  leaves.push(c)
}
const tree = L.treeOf(leaves)
const logs = await chain.getLogs({ address: X.pool6.address, event: X.pool6Abi[4], fromBlock: BigInt(firstBlock) })
const published = logs.filter((l) => l.args.root === bytesToHex(tree.root)).at(-1)
if (!published) throw new Error('v5p: the pool did not publish the final root')
const slot = BigInt(published.args.slot!)
for (const [i, n] of notes.entries()) {
  const recipient = fresh(`v5p/${i}`)
  const binding = X.bindingOf(recipient, funder, 0n)
  const w = L.v5(n.ns, n.s, bytes(binding), tree, i)
  if (bytesToHex(w.nf) !== n.nf) throw new Error('v5p: nf differs')
  const proof = L.prove('v5_tornado', w.input, 0)
  if (!proof.verified) throw new Error('v5p: the proof does not verify')
  await frameStep(`v5p: withdraw note ${i}, from pot ${n.pot}`, X.withdrawPotTx(chainId, n.nf, X.triple(X.LEANSTARK_SCHEME, bytesToHex(w.D), X.VK5), bytesToHex(tree.root), slot, recipient, funder, 0n), { version: 5, pot: n.pot, declaredGas: X.LEANSTARK_VERIFICATION_GAS, proof: { cycles: proof.cycles, proofBytes: proof.proofBytes } })
}

await stopNode(nodeA.child)
const lastBlock = Number(await chain.getBlockNumber())

// ---- the record ----

const record = {
  experiment: 19, run: runLabel, deployment: X.DEPLOYMENT, repoCommit, chainId: Number(chainId), funder,
  contracts: { pool6: X.pool6.address, pots: X.pots.map((p) => p.address), singleton: X12.SINGLETON, source: X.POOL6_SOURCE },
  vk: { v1: X.VK1, v5: X.VK5, note: 'keccak256 of each program\'s source at leanVM 3cbac04, standing in for the compiled program\'s key' },
  blocks: { first: firstBlock, last: lastBlock }, pins, setup, rows, ...out,
}
const fixture = { chainId: Number(chainId), contracts: record.contracts, vk: record.vk, transactions: txs }
const big = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)
for (const [name, body] of [['record', JSON.stringify(record, big)], ['fixture', JSON.stringify(fixture, big)]] as const) {
  for (const s of secrets) {
    const bare = s.replace(/^0x/, '').toLowerCase()
    if (bare.length >= 32 && body.toLowerCase().includes(bare)) throw new Error(`the ${name} contains a secret; not written`)
  }
}
writeFileSync(join(here, 'results', `${runLabel}.json`), JSON.stringify(record, big, 2) + '\n')
writeFileSync(join(root, 'test/fixtures/x14', `${runLabel}.json`), JSON.stringify(fixture, null, 1) + '\n')
console.log(`recorded results/${runLabel}.json and test/fixtures/x14/${runLabel}.json`)
process.exit(0)
