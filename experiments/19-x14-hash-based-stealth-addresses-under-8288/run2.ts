// Experiment 19 (X14), run 2 on the test network, EIP-8288 modelled: version 2a (Amendment 2).
//   arm 1  version 2a paid through the factory, announced through ERC-5564's singleton, and spent
//          with a leanVM proof that its committed rule accepts leanSPHINCS signatures on the message.
//   arm 2  two rules, one stub: an account of one key and one of two of three keys, both spent.
//   arm 3  a delegated prover is given what proving the owner's spend needs (the rule, the keys, r,
//          the message and the owner's signature on it) and tries to spend to itself: it proves its
//          own message with the owner's signature, then sends the owner's proof with its own
//          destination; it then sends the owner's spend, the one thing it can do.
// Every proof is made and verified off chain by prover/ before its transaction is sent. Every frame
// transaction is simulated, sent to a skandha node at its pin with the answer recorded, then to the
// chain. Spends go to fresh addresses.
//
// usage: X14_DEPLOYMENT=<tag> npx tsx experiments/19-x14-hash-based-stealth-addresses-under-8288/run2.ts <n>-<label>
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
if (!runLabel) throw new Error('usage: run2.ts <n>-<label>')
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
console.log(`deployment ${X.DEPLOYMENT}: factory ${X.factory.address}, VK2A ${X.VK2A}`)
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

// ---- the recipient: an ML-KEM key for announcements and three leanSPHINCS seeds ----

const kem = ml_kem768.keygen(secretBytes('recipient/kem', 64))
const seeds = [0, 1, 2].map((i) => secretBytes(`recipient/v2a/key/${i}`))
const pks = seeds.map(L.sphincsKey)
const ZERO = new Uint8Array(32)
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

type Account = { label: string; rule: bigint; keys: Uint8Array[]; r: Uint8Array; C: Hex; account: Address }
async function v2aAccount(label: string, rule: bigint): Promise<Account> {
  const keys = rule === L.RULE_ONE ? [pks[0], ZERO, ZERO] : pks
  const e = encapsulate()
  secrets.push(bytesToHex(e.r))
  const C = bytesToHex(keccak_256(Buffer.concat([Buffer.from(L.ruleKeyOf(rule, keys)), Buffer.from(e.r)])))
  const account = await pay(`v2a: pay and announce, ${label}`, 2n, C, X.VK2A, C, e.ct, e.viewTag)
  return { label, rule, keys, r: e.r, C, account }
}
const bytes = (h: Hex) => Buffer.from(h.slice(2), 'hex')
/** The owner's side: m for this destination, signed by the keys at `by`. */
async function ownerSigns(a: Account, destination: Address, by: number[]) {
  const nonce = await getNonceSeq(chain, a.account, [0n])
  const m = X.messageOf(a.account, nonce, destination, AMOUNT)
  const signed = by.map((index) => ({ index, signed: L.sign(seeds[index], bytes(m)) }))
  if (!signed.every((s) => s.signed.verified)) throw new Error('a signature does not verify')
  return { nonce, m, signed }
}
/** The prover's side: a proof of the account's rule over these signatures, for this message. */
function proveFor(a: Account, m: Hex, signed: { index: number; signed: L.Signed }[]) {
  const w = L.v2a(a.rule, a.keys, a.r, bytes(m), signed)
  if (bytesToHex(w.C) !== a.C) throw new Error(`${a.label}: C differs`)
  const data = `0x${bytesToHex(w.T).slice(2)}${X.triple(X.LEANSTARK_SCHEME, bytesToHex(w.D), X.VK2A).slice(2)}` as Hex
  return { w, data, proof: L.tryProve('v2a_rules', w.input) }
}
async function spend(step: string, a: Account, destination: Address, by: number[]) {
  const s = await ownerSigns(a, destination, by)
  const p = proveFor(a, s.m, s.signed)
  if ('error' in p.proof || !p.proof.verified) throw new Error(`${step}: no proof: ${JSON.stringify(p.proof)}`)
  return frameStep(step, X.spendTx(chainId, a.account, s.nonce, p.data, destination, AMOUNT), { version: 2, rule: a.rule === L.RULE_ONE ? 'one key' : 'two of three', declaredGas: X.LEANSTARK_VERIFICATION_GAS, proof: { cycles: p.proof.cycles, proofBytes: p.proof.proofBytes, proveMs: p.proof.warmupMs, verifyMs: p.proof.verifyMs }, publicInputHash: bytesToHex(p.w.D) })
}

// ---- arms 1 and 2: two rules, one stub ----

const one = await v2aAccount('one key', L.RULE_ONE)
const two = await v2aAccount('two of three keys', L.RULE_TWO_OF_THREE)
const sOne = await spend('v2a: the owner spends, one key', one, fresh('v2a/one'), [0])
const sTwo = await spend('v2a: the owner spends, two of three keys (keys 2 and 0)', two, fresh('v2a/two'), [2, 0])
const codeOne = (await chain.getCode({ address: one.account }))!
const codeTwo = (await chain.getCode({ address: two.account }))!
const words = (code: Hex) => ({ runtime: code.slice(0, -192), version: code.slice(-192, -128), C: code.slice(-128, -64), vk: code.slice(-64) })
const [wOne, wTwo] = [words(codeOne), words(codeTwo)]
out.prediction1 = {
  codeBytes: [(codeOne.length - 2) / 2, (codeTwo.length - 2) / 2],
  runtimeIdentical: wOne.runtime === wTwo.runtime,
  versionIdentical: wOne.version === wTwo.version,
  programKeyIdentical: wOne.vk === wTwo.vk,
  onlyCDiffers: wOne.runtime === wTwo.runtime && wOne.version === wTwo.version && wOne.vk === wTwo.vk && wOne.C !== wTwo.C,
  declaredKeys: [X.VK2A, X.VK2A],
  calldataBytes: [sOne.calldataBytes, sTwo.calldataBytes],
  gasUsed: [sOne.gasUsed, sTwo.gasUsed],
  gasDifference: Math.abs(sOne.gasUsed - sTwo.gasUsed),
  runtimeBytes: (wOne.runtime.length - 2) / 2,
}
console.log(`prediction 1: ${JSON.stringify(out.prediction1)}`)

// ---- arm 3: a delegated prover ----

const d = await v2aAccount('delegated', L.RULE_ONE)
const ownerDestination = fresh('v2a/delegated/owner')
const proverAddress = fresh('v2a/delegated/prover')
const given = await ownerSigns(d, ownerDestination, [0])
// What the prover holds: the rule, the keys, r, the owner's message and the signature on it. It
// never holds a seed.
const own = X.messageOf(d.account, given.nonce, proverAddress, AMOUNT)
const attemptOwnMessage = proveFor(d, own, given.signed).proof
const ownersProof = proveFor(d, given.m, given.signed)
if ('error' in ownersProof.proof) throw new Error(`the owner's proof: ${ownersProof.proof.error}`)
const redirected = X.spendTx(chainId, d.account, given.nonce, ownersProof.data, proverAddress, AMOUNT)
const redirectedSim = await simulateFrameTx(chain, redirected)
out.delegated = {
  ownMessageProof: 'error' in attemptOwnMessage ? { refused: attemptOwnMessage.error } : { proved: attemptOwnMessage.verified },
  ownersProofToProver: { valid: redirectedSim.valid, violation: redirectedSim.violation, executionStatus: redirectedSim.executionStatus },
}
console.log(`arm 3: ${JSON.stringify(out.delegated)}`)
await frameStep('v2a: the delegated prover sends the owner\'s spend, to the owner\'s destination', X.spendTx(chainId, d.account, given.nonce, ownersProof.data, ownerDestination, AMOUNT), { version: 2, rule: 'one key', declaredGas: X.LEANSTARK_VERIFICATION_GAS, proof: { cycles: ownersProof.proof.cycles, proofBytes: ownersProof.proof.proofBytes, proveMs: ownersProof.proof.warmupMs }, publicInputHash: bytesToHex(ownersProof.w.D) })
Object.assign(out.delegated as object, {
  proverBalance: (await chain.getBalance({ address: proverAddress })).toString(),
  ownerDestinationBalance: (await chain.getBalance({ address: ownerDestination })).toString(),
  expected: AMOUNT.toString(),
})

await stopNode(nodeA.child)
const lastBlock = Number(await chain.getBlockNumber())

// ---- the record ----

const record = {
  experiment: 19, run: runLabel, deployment: X.DEPLOYMENT, repoCommit, chainId: Number(chainId), funder,
  contracts: { factory: X.factory.address, singleton: X12.SINGLETON },
  vk: { v1: X.VK1, v5: X.VK5, v2a: X.VK2A, note: 'keccak256 of each program\'s source at leanVM 3cbac04, standing in for the compiled program\'s key' },
  publicKeys: pks.map((k) => bytesToHex(k)),
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
