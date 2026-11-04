// Experiment 19 (X14), run 2 on the test network, EIP-8288 modelled: version 2b (Amendment 3), one
// interpreter program over a committed rule, prediction 11: three accounts of three rules, one key
// with t = 1, three keys with t = 2, and version 1's preimage rule, each paid through the factory,
// announced through ERC-5564's singleton and spent, under one program key.
// Every proof is made and verified off chain by prover/ before its transaction is sent. Every frame
// transaction is simulated, sent to a skandha node at its pin with the answer recorded, then to the
// chain. Spends go to fresh addresses.
//
// usage: X14_DEPLOYMENT=<tag> npx tsx experiments/19-x14-hash-based-stealth-addresses-under-8288/run2b.ts <n>-<label>
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256 } from '@noble/hashes/sha2'
import { keccak_256 } from '@noble/hashes/sha3'
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js'
import { type Address, type Hex, bytesToHex, encodeFunctionData, numberToHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { type Pin, buildSkandha, checkout, loadKey, rpcUrlOf, run, startNode, stopNode, writeConfig } from '../../src/e2e/index.js'
import { sendFrames } from '../../src/exp-frames/deploy.js'
import { CPSB, NEW_ACCOUNT_STATE_GAS, type FrameTx, frameReceiptGas, frameReceiptStatus, frameTxHash, getNonceSeq, makeClient, senderFrame, serializeFrameTx, simulateFrameTx, waitForFrameTxReceipt } from '../../src/exp-frames/frametx/index.js'
import * as X12 from '../17-x12-ciphertexts-in-blobs/x12.js'
import * as L from './lean.js'
import * as X from './x14.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const work = join(root, 'work')
const runLabel = process.argv[2]
if (!runLabel) throw new Error('usage: run2b.ts <n>-<label>')
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
console.log(`deployment ${X.DEPLOYMENT}: factory ${X.factory.address}, VK2B ${X.VK2B}`)
const existing = await chain.getCode({ address: X.factory.address })
if (existing && existing !== '0x') throw new Error('already deployed: set X14_DEPLOYMENT to a fresh tag')
const firstBlock = (await setupTx('deploy the factory', [X.factory.deploy])).block

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

// ---- the recipient: an ML-KEM key for announcements, three leanSPHINCS seeds and a preimage k ----

const kem = ml_kem768.keygen(secretBytes('recipient/kem', 64))
const seeds = [0, 1, 2].map((i) => secretBytes(`recipient/v2b/key/${i}`))
const pks = seeds.map(L.sphincsKey)
const k = secretBytes('recipient/v2b/k')
const DS_R = new TextEncoder().encode('exp-e2e-frames/19/r')
const DS_TAG = new TextEncoder().encode('exp-e2e-frames/19/view-tag')
function encapsulate() {
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(kem.publicKey, rnd(32))
  return { ct: cipherText, r: keccak_256(Buffer.concat([DS_R, sharedSecret])), viewTag: sha256(Buffer.concat([DS_TAG, sharedSecret]))[0] }
}
const AMOUNT = X.DENOM
const FUND = 2n * X.DENOM

async function pay(step: string, version: bigint, w: Hex, vk: Hex, salt: Hex, ct: Uint8Array, viewTag: number) {
  const account = X.accountOf(version, w, vk, salt)
  await setupTx(step, [
    senderFrame({ target: X.factory.address, value: FUND, data: encodeFunctionData({ abi: X.factoryAbi, functionName: 'pay', args: [version, w, vk, salt] }), execution: 400_000n, state: NEW_ACCOUNT_STATE_GAS + CPSB * BigInt((X.stealthCode.length - 2) / 2 + 96) }),
    senderFrame({ target: X12.SINGLETON, data: encodeFunctionData({ abi: X12.singletonAbi, functionName: 'announce', args: [6n, account, bytesToHex(ct), numberToHex(viewTag, { size: 1 })] }), execution: 60_000n, state: 0n }),
  ])
  const r = setup[setup.length - 1]
  rows.push({ step, hash: r.hash, block: r.block, gasUsed: r.gasUsed, frames: r.frames, account })
  const code = await chain.getCode({ address: account })
  if (!code || code === '0x') throw new Error(`${step}: no account at ${account}`)
  return account
}

const E: L.Slot = { type: L.SLOT_EMPTY, value: new Uint8Array(32) }
const keySlot = (i: number): L.Slot => ({ type: L.SLOT_KEY, value: pks[i] })
const rules: { label: string; rule: L.Rule; uses: number[] }[] = [
  { label: 'one key', rule: { t: 1, slots: [keySlot(0), E, E] }, uses: [0] },
  { label: 'two of three keys', rule: { t: 2, slots: [keySlot(0), keySlot(1), keySlot(2)] }, uses: [2, 0] },
  { label: 'version 1\'s preimage rule', rule: { t: 1, slots: [{ type: L.SLOT_PREIMAGE, value: L.preimageKeyOf(k) }, E, E] }, uses: [0] },
]
const bytes = (h: Hex) => Buffer.from(h.slice(2), 'hex')
const spent: Record<string, unknown>[] = []
const codes: Hex[] = []
for (const [i, a] of rules.entries()) {
  const e = encapsulate()
  secrets.push(bytesToHex(e.r))
  const C = bytesToHex(keccak_256(Buffer.concat([Buffer.from(L.interpretedKeyOf(a.rule)), Buffer.from(e.r)])))
  const account = await pay(`v2b: pay and announce, ${a.label}`, 2n, C, X.VK2B, C, e.ct, e.viewTag)
  codes.push((await chain.getCode({ address: account }))!)
  const destination = fresh(`v2b/${i}`)
  const nonce = await getNonceSeq(chain, account, [0n])
  const m = X.messageOf(account, nonce, destination, AMOUNT)
  const used = a.uses.map((index) => a.rule.slots[index].type === L.SLOT_KEY ? { index, signed: L.sign(seeds[index], bytes(m)) } : { index, k })
  const w = L.v2b(a.rule, e.r, bytes(m), used)
  if (bytesToHex(w.C) !== C) throw new Error(`${a.label}: C differs`)
  const proof = L.tryProve('v2b_interpreter', w.input)
  if ('error' in proof || !proof.verified) throw new Error(`${a.label}: no proof: ${JSON.stringify(proof)}`)
  const data = `0x${bytesToHex(w.T).slice(2)}${X.triple(X.LEANSTARK_SCHEME, bytesToHex(w.D), X.VK2B).slice(2)}` as Hex
  spent.push(await frameStep(`v2b: the owner spends, ${a.label}`, X.spendTx(chainId, account, nonce, data, destination, AMOUNT), { version: 2, program: 'v2b_interpreter', rule: a.label, declaredGas: X.LEANSTARK_VERIFICATION_GAS, proof: { cycles: proof.cycles, proofBytes: proof.proofBytes, proveMs: proof.warmupMs, verifyMs: proof.verifyMs }, publicInputHash: bytesToHex(w.D) }))
}
const words = (code: Hex) => ({ runtime: code.slice(0, -192), version: code.slice(-192, -128), C: code.slice(-128, -64), vk: code.slice(-64) })
const w = codes.map(words)
const gas = spent.map((r) => r.gasUsed as number)
out.prediction11 = {
  codeBytes: codes.map((c) => (c.length - 2) / 2),
  runtimeIdentical: w.every((x) => x.runtime === w[0].runtime),
  versionIdentical: w.every((x) => x.version === w[0].version),
  programKeyIdentical: w.every((x) => x.vk === w[0].vk),
  onlyCDiffers: w.every((x) => x.runtime === w[0].runtime && x.version === w[0].version && x.vk === w[0].vk) && new Set(w.map((x) => x.C)).size === w.length,
  declaredKeys: rules.map(() => X.VK2B),
  calldataBytes: spent.map((r) => r.calldataBytes),
  gasUsed: gas,
  gasSpread: Math.max(...gas) - Math.min(...gas),
}
console.log(`prediction 11: ${JSON.stringify(out.prediction11)}`)

await stopNode(nodeA.child)
const lastBlock = Number(await chain.getBlockNumber())

// ---- the record ----

const record = {
  experiment: 19, run: runLabel, deployment: X.DEPLOYMENT, repoCommit, chainId: Number(chainId), funder,
  contracts: { factory: X.factory.address, singleton: X12.SINGLETON },
  vk: { v1: X.VK1, v5: X.VK5, v2a: X.VK2A, v2b: X.VK2B, note: 'keccak256 of each program\'s source at leanVM 3cbac04, standing in for the compiled program\'s key' },
  publicKeys: pks.map((p) => bytesToHex(p)),
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
