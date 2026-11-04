// Experiment 19 (X14), run 1 on the test network, EIP-8288 modelled: versions 1, 3, 4 and 5.
//   v1  a stealth account paid through the factory and announced through ERC-5564's singleton
//       (schemeId 6, the ML-KEM ciphertext), spent with a leanVM proof of its secrets; and a second
//       account whose spend a delegated prover, given what proving needs, sends to itself.
//   v3  two accounts of one recipient under its long-term leanSPHINCS key, both spent.
//   v4  Tornado as deployed: a deposit, and a relayer's withdrawal with a Groth16 proof.
//   v5  Tornado's statement in a Keccak tree under a modelled EIP-8288: two deposits, a withdrawal,
//       and a delegated prover's withdrawal to itself.
// Every proof is made and verified off chain (prover/ for leanVM, snarkjs for Groth16) before its
// transaction is sent. Every frame transaction is simulated, sent to a skandha node at its pin with
// the answer recorded, then to the chain. Spends go to fresh addresses.
//
// usage: X14_DEPLOYMENT=<tag> npx tsx experiments/19-x14-hash-based-stealth-addresses-under-8288/run.ts <n>-<label>
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256 } from '@noble/hashes/sha2'
import { keccak_256 } from '@noble/hashes/sha3'
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js'
import { buildBabyjub, buildPedersenHash } from 'circomlibjs'
import * as snarkjs from 'snarkjs'
import { type Address, type Hex, bytesToHex, createWalletClient, decodeEventLog, encodeFunctionData, hexToBigInt, http, keccak256, numberToHex } from 'viem'
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts'
import { type Pin, buildSkandha, checkout, loadKey, rpcUrlOf, run, startNode, stopNode, writeConfig } from '../../src/e2e/index.js'
import { sendFrames } from '../../src/exp-frames/deploy.js'
import { CPSB, NEW_ACCOUNT_STATE_GAS, type FrameTx, frameReceiptGas, frameReceiptStatus, frameTxHash, getNonceSeq, hegotaTestnet, makeClient, senderFrame, serializeFrameTx, simulateFrameTx, waitForFrameTxReceipt } from '../../src/exp-frames/frametx/index.js'
import { FIELD, H as mimc, proofWords, treeOf as mimcTree } from '../15-x10-out-and-back/x10.js'
import * as X12 from '../17-x12-ciphertexts-in-blobs/x12.js'
import * as L from './lean.js'
import * as X from './x14.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const work = join(root, 'work')
const runLabel = process.argv[2]
if (!runLabel || !/^\d+-[a-z0-9-]+$/.test(runLabel)) throw new Error('usage: run.ts <n>-<label>')
mkdirSync(join(here, 'results'), { recursive: true })
mkdirSync(join(root, 'test/fixtures/x14'), { recursive: true })
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8')) as Record<string, Pin>
const { privateKey, address: funder } = loadKey()
const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
const dirty = (await run('git', ['status', '--porcelain', '--', X.DIR, 'src'], { cwd: root })).trim()
if (dirty) throw new Error(`commit the experiment before a recorded run:\n${dirty}`)

const chain = makeClient()
const chainId = BigInt(await chain.getChainId())
const wallet = createWalletClient({ account: privateKeyToAccount(privateKey), chain: hegotaTestnet, transport: http() })
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
console.log(`deployment ${X.DEPLOYMENT}: factory ${X.factory.address}, pool5 ${X.pool5.address}, pool4 ${X.pool4.address}`)
if ((await chain.getCode({ address: X.factory.address })) ?? '0x' !== '0x') {
  const code = await chain.getCode({ address: X.factory.address })
  if (code && code !== '0x') throw new Error('already deployed: set X14_DEPLOYMENT to a fresh tag')
}
const firstBlock = (await setupTx('deploy the factory, the two pools and version 4\'s verifier', [X.factory.deploy, X.pool5.deploy, X.verifier4.deploy, X.pool4.deploy])).block
await setupTx('version 5\'s pool float', [senderFrame({ target: X.pool5.address, value: 10n ** 15n, execution: 50_000n, state: 0n })])

// skandha at its pin: every frame transaction's answer is recorded, then it goes to the chain.
const skandha = await checkout('skandha', pins.skandha, work)
await buildSkandha(skandha)
const stamp = Date.now()
const config = join(work, `x14-${stamp}.json`)
writeConfig(config)
const nodeA = await startNode({ dir: skandha, name: 'A', config, dataDir: join(work, `a-${stamp}`), apiPort: 15337, wsPort: 15437, p2pPort: 15000, log: join(work, `a-${stamp}.frames.jsonl`), out: join(work, `a-${stamp}.out`) })

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
  // One node relays nothing (experiment 18), so the chain directly, at once.
  try { await chain.request({ method: 'eth_sendRawTransaction', params: [raw] } as never) } catch (e) { if (!/known|already/i.test((e as Error).message)) throw e }
  const r = await waitForFrameTxReceipt(chain, hash, { timeoutMs: 180_000 })
  const frames = r.frameReceipts.map((f) => ({ status: frameReceiptStatus(f), ...frameReceiptGas(f) }))
  const ok = frames.every((f) => f.status === 1)
  const row = { step, outcome: ok ? 'mined' : 'mined, a frame failed', hash, block: Number(BigInt(r.blockNumber)), gasUsed: Number(BigInt(r.gasUsed)), frames: frames.map((f) => ({ status: f.status, execution: Number(f.execution), state: Number(f.state) })), skandha: skandhaAnswer, ...extra }
  console.log(`${step}: ${hash} block ${row.block} gasUsed ${row.gasUsed} frames ${frames.map((f) => `${f.status}:${f.execution}+${f.state}s`).join(' / ')}`)
  rows.push(row)
  txs.push({ step, hash, raw })
  if (!ok) throw new Error(`${step}: a frame failed`)
  return row
}
async function eoaStep(step: string, hash: Hex, extra: Record<string, unknown> = {}) {
  const r = await chain.waitForTransactionReceipt({ hash, timeout: 180_000 })
  const tx = await chain.getTransaction({ hash })
  const row = { step, outcome: r.status === 'success' ? 'mined' : 'reverted', hash, block: Number(r.blockNumber), gasUsed: Number(r.gasUsed), calldataBytes: (tx.input.length - 2) / 2, ...extra }
  console.log(`${step}: ${hash} block ${row.block} gasUsed ${row.gasUsed}`)
  rows.push(row)
  if (r.status !== 'success') throw new Error(`${step}: reverted`)
  return { row, receipt: r }
}

// ---- the recipient: an ML-KEM key for announcements, a spending key k, a leanSPHINCS seed ----

const kemSeed = secretBytes('recipient/kem', 64)
const kem = ml_kem768.keygen(kemSeed)
const k = secretBytes('recipient/k')
const sphincsSeed = secretBytes('recipient/sphincs')
const DS_R = new TextEncoder().encode('exp-e2e-frames/19/r')
const DS_TAG = new TextEncoder().encode('exp-e2e-frames/19/view-tag')

/** The sender's side of a payment: encapsulate, derive r, and the announcement's view tag. */
function encapsulate() {
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(kem.publicKey, rnd(32))
  return { ct: cipherText, r: keccak_256(Buffer.concat([DS_R, sharedSecret])), viewTag: sha256(Buffer.concat([DS_TAG, sharedSecret]))[0] }
}
const AMOUNT = X.DENOM
const FUND = 2n * X.DENOM

async function pay(step: string, version: bigint, w: Hex, vk: Hex, salt: Hex, ct: Uint8Array, viewTag: number) {
  const account = X.accountOf(version, w, vk, salt)
  await setupTx(step, [
    // The account's code is state: 1,530 a byte on this network (EIP-8037), with the new account's
    // 183,600 (pass d1 stopped with state for an empty account, the shortfall spilling into execution).
    senderFrame({ target: X.factory.address, value: FUND, data: encodeFunctionData({ abi: X.factoryAbi, functionName: 'pay', args: [version, w, vk, salt] }), execution: 400_000n, state: NEW_ACCOUNT_STATE_GAS + CPSB * BigInt((X.stealthCode.length - 2) / 2 + 96) }),
    senderFrame({ target: X12.SINGLETON, data: encodeFunctionData({ abi: X12.singletonAbi, functionName: 'announce', args: [6n, account, bytesToHex(ct), numberToHex(viewTag, { size: 1 })] }), execution: 60_000n, state: 0n }),
  ])
  const r = setup[setup.length - 1]
  rows.push({ step, hash: r.hash, block: r.block, gasUsed: r.gasUsed, frames: r.frames, account })
  if ((await chain.getCode({ address: account })) === undefined) throw new Error(`${step}: no account at ${account}`)
  return account
}

// ---- v1: two accounts, one spent by its owner, one by a delegated prover to itself ----

const K = keccak_256(Buffer.concat([Buffer.from(k), Buffer.from(L.TAG_KEY)]))
async function v1Account(label: string) {
  const e = encapsulate()
  secrets.push(bytesToHex(e.r))
  const C = bytesToHex(keccak_256(Buffer.concat([Buffer.from(K), Buffer.from(e.r)])))
  const account = await pay(`v1: pay and announce, ${label}`, 1n, C, X.VK1, C, e.ct, e.viewTag)
  return { account, r: e.r, C }
}
async function v1Spend(step: string, a: { account: Address; r: Uint8Array; C: Hex }, destination: Address) {
  const nonce = await getNonceSeq(chain, a.account, [0n])
  const m = X.messageOf(a.account, nonce, destination, AMOUNT)
  const w = L.v1(k, a.r, Buffer.from(m.slice(2), 'hex'))
  if (bytesToHex(w.C) !== a.C) throw new Error(`${step}: C differs`)
  const proof = L.prove('v1_preimage', w.input, 0)
  if (!proof.verified) throw new Error(`${step}: the proof does not verify`)
  const data = `0x${bytesToHex(w.T).slice(2)}${X.triple(X.LEANSTARK_SCHEME, bytesToHex(w.D), X.VK1).slice(2)}` as Hex
  return frameStep(step, X.spendTx(chainId, a.account, nonce, data, destination, AMOUNT), { version: 1, declaredGas: X.LEANSTARK_VERIFICATION_GAS, proof: { cycles: proof.cycles, proofBytes: proof.proofBytes, proveMs: proof.warmupMs, verifyMs: proof.verifyMs }, publicInputHash: bytesToHex(w.D) })
}
const a1 = await v1Account('owner')
await v1Spend('v1: the owner spends to a fresh address', a1, fresh('v1/owner'))
// The delegated prover is given k, r and the owner's message for a2. It proves its own message.
const a2 = await v1Account('delegated')
const prover = fresh('v1/prover')
await v1Spend('v1: a delegated prover holding k and r spends to itself', a2, prover)
out.v1Delegated = { proverBalance: (await chain.getBalance({ address: prover })).toString(), expected: AMOUNT.toString() }

// ---- v3: two accounts under one long-term leanSPHINCS key ----

const sphincs = (seed: Uint8Array, m: Hex) => JSON.parse(execFileSync(L.PROVER, ['sphincs', bytesToHex(seed).slice(2), m.slice(2)], { encoding: 'utf8' })) as { publicKey: string; verified: boolean; otherMessageVerified: boolean; signatureBytes: number; signMs: number; verifyMs: number; signatureKeccak: string }
const pkR = `0x${sphincs(sphincsSeed, `0x${'00'.repeat(32)}`).publicKey}` as Hex
const seen: Hex[] = []
for (const label of ['first', 'second']) {
  const e = encapsulate()
  const salt = keccak256(`0x${pkR.slice(2)}${bytesToHex(e.r).slice(2)}` as Hex)
  const account = await pay(`v3: pay and announce, ${label} account`, 3n, pkR, `0x${'00'.repeat(32)}`, salt, e.ct, e.viewTag)
  const destination = fresh(`v3/${label}`)
  const nonce = await getNonceSeq(chain, account, [0n])
  const m = X.messageOf(account, nonce, destination, AMOUNT)
  const sig = sphincs(sphincsSeed, m)
  if (!sig.verified || sig.otherMessageVerified) throw new Error('v3: the signature does not verify as it should')
  const row = await frameStep(`v3: the ${label} account spends, under the long-term key`, X.spendTx(chainId, account, nonce, X.triple(X.LEANSPHINCS_SCHEME, m, pkR), destination, AMOUNT), { version: 3, declaredGas: X.LEANSPHINCS_VERIFICATION_GAS, signature: { bytes: sig.signatureBytes, keccak: sig.signatureKeccak, signMs: sig.signMs, verifyMs: sig.verifyMs } })
  const tx = await chain.getTransaction({ hash: row.hash as Hex }).catch(() => undefined)
  seen.push(X.triple(X.LEANSPHINCS_SCHEME, m, pkR).slice(-64) as Hex)
  void tx
}
out.v3Linkage = { keysOnChain: seen.map((s) => `0x${s}`), same: seen[0] === seen[1], key: pkR }

// ---- v5: Tornado's statement in a Keccak tree, under a modelled EIP-8288 ----

const notes5 = ['owner', 'delegated'].map((l) => ({ l, ns: secretBytes(`v5/${l}/ns`), s: secretBytes(`v5/${l}/s`) }))
const leaves5: Uint8Array[] = []
for (const n of notes5) {
  const c = L.leafOf(n.ns, n.s)
  const { row } = await eoaStep(`v5: deposit, ${n.l}`, await wallet.writeContract({ address: X.pool5.address, abi: X.pool5Abi, functionName: 'deposit', args: [bytesToHex(c)], value: X.DENOM, gas: 900_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 1n } as never))
  void row
  leaves5.push(c)
}
for (const [i, n] of notes5.entries()) {
  const recipient = n.l === 'owner' ? fresh('v5/owner') : fresh('v5/prover')
  const relayer = funder
  const binding = X.bindingOf(recipient, relayer, 0n)
  const w = L.v5(n.ns, n.s, Buffer.from(binding.slice(2), 'hex'), L.treeOf(leaves5), i)
  const proof = L.prove('v5_tornado', w.input, 0)
  if (!proof.verified) throw new Error('v5: the proof does not verify')
  await frameStep(n.l === 'owner' ? 'v5: the owner withdraws to a fresh address' : 'v5: a delegated prover holding the note\'s secrets withdraws to itself', X.withdraw5Tx(chainId, bytesToHex(w.nf), X.triple(X.LEANSTARK_SCHEME, bytesToHex(w.D), X.VK5), bytesToHex(w.root), recipient, relayer, 0n), { version: 5, declaredGas: X.LEANSTARK_VERIFICATION_GAS, proof: { cycles: proof.cycles, proofBytes: proof.proofBytes, proveMs: proof.warmupMs, verifyMs: proof.verifyMs }, publicInputHash: bytesToHex(w.D) })
}

// ---- v4: Tornado as deployed, a Groth16 proof of its circuit ----

{
  const pedersen = await buildPedersenHash()
  const babyJub = await buildBabyjub()
  const leInt = (x: bigint, n: number) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) { b[i] = Number(x & 0xffn); x >>= 8n } return b }
  const ph = (b: Buffer) => babyJub.F.toObject(babyJub.unpackPoint(pedersen.hash(b))[0]) as bigint
  const nullifier = hexToBigInt(bytesToHex(secretBytes('v4/nullifier', 31)))
  const secret = hexToBigInt(bytesToHex(secretBytes('v4/secret', 31)))
  const commitment = ph(Buffer.concat([leInt(nullifier, 31), leInt(secret, 31)]))
  const nullifierHash = ph(leInt(nullifier, 31))
  await eoaStep('v4: deposit', await wallet.writeContract({ address: X.pool4.address, abi: X.pool4Abi, functionName: 'deposit', args: [X.word(commitment)], value: X.DENOM, gas: 1_600_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 1n } as never))
  const tree = mimcTree([commitment])
  const p = tree.path(0)
  const recipient = fresh('v4/owner')
  const input = { root: tree.root, nullifierHash, recipient: hexToBigInt(recipient), relayer: hexToBigInt(funder), fee: 0n, refund: 0n, nullifier, secret, pathElements: p.pathElements, pathIndices: p.pathIndices }
  const t0 = Date.now()
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(Object.fromEntries(Object.entries(input).map(([kk, v]) => [kk, Array.isArray(v) ? v.map(String) : String(v)])), join(here, 'build/withdraw_js/withdraw.wasm'), join(here, 'build/withdraw.zkey'))
  const proveMs = Date.now() - t0
  if (!(await snarkjs.groth16.verify(X.VKEY4, publicSignals, proof))) throw new Error('v4: snarkjs refuses its own proof')
  const words = proofWords(proof)
  await eoaStep('v4: a relayer withdraws to a fresh address with a Groth16 proof', await wallet.writeContract({ address: X.pool4.address, abi: X.pool4Abi, functionName: 'withdraw', args: [words, X.word(tree.root), X.word(nullifierHash), recipient, funder, 0n, 0n], gas: 900_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 1n } as never), { version: 4, proveMs, mimcCheck: mimc(1n, 2n) < FIELD })
}

await stopNode(nodeA.child)
const lastBlock = Number(await chain.getBlockNumber())

// ---- the record ----

const record = {
  experiment: 19, run: runLabel, deployment: X.DEPLOYMENT, repoCommit, chainId: Number(chainId), funder,
  contracts: { factory: X.factory.address, pool5: X.pool5.address, pool4: X.pool4.address, verifier4: X.verifier4.address, singleton: X12.SINGLETON },
  vk: { v1: X.VK1, v5: X.VK5, note: 'keccak256 of each program\'s source at leanVM 3cbac04, standing in for the compiled program\'s key' },
  blocks: { first: firstBlock, last: lastBlock }, pins, setup, rows, ...out,
}
const fixture = { chainId: Number(chainId), contracts: record.contracts, vk: record.vk, transactions: txs }
for (const [name, body] of [['record', JSON.stringify(record)], ['fixture', JSON.stringify(fixture)]] as const) {
  for (const s of secrets) {
    const bare = s.replace(/^0x/, '').toLowerCase()
    if (bare.length >= 32 && body.toLowerCase().includes(bare)) throw new Error(`the ${name} contains a secret; not written`)
  }
}
writeFileSync(join(here, 'results', `${runLabel}.json`), JSON.stringify(record, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n')
writeFileSync(join(root, 'test/fixtures/x14', `${runLabel}.json`), JSON.stringify(fixture, null, 1) + '\n')
console.log(`recorded results/${runLabel}.json and test/fixtures/x14/${runLabel}.json`)
process.exit(0)
