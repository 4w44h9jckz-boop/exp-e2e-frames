// Experiment 19 (X14), run 2: the local chain (Amendment 3). ethrex at the test network's commit,
// patched with EIP-8288 by ethrex.sh, in dev mode, under one setting:
//   written   the EIP as written: leanSPHINCS dependencies proved by leanVM's own aggregation;
//             a leanSTARK dependency frame makes its transaction invalid.
//   extended  the experiment's extension: leanSTARK dependencies valid, each proof checked
//             directly in the block.
// Every version but 4 is paid and spent with its dependency in a frame of its own (mode 4), its
// witness handed to the node first. Arm 6: on the runner's switch, the builder proves the next
// block's dependencies less one, or other dependencies, and the node must refuse the block.
// Prediction 5 compares each transaction's gas with the modelled figure from the test network's
// rerun on the same contracts (results/2-part2-testnet*.json): measured plus declared.
//
// usage: X14_DEPLOYMENT=<tag> npx tsx experiments/19-x14-hash-based-stealth-addresses-under-8288/local.ts <label> <written|extended>
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256 } from '@noble/hashes/sha2'
import { keccak_256 } from '@noble/hashes/sha3'
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js'
import { type Address, type Hex, bytesToHex, createWalletClient, defineChain, encodeFunctionData, http, keccak256, numberToHex } from 'viem'
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts'
import { loadKey, run } from '../../src/e2e/index.js'
import { sendFrames } from '../../src/exp-frames/deploy.js'
import { CPSB, NEW_ACCOUNT_STATE_GAS, type FrameTx, frameReceiptGas, frameReceiptStatus, frameTxHash, getNonceSeq, makeClient, senderFrame, serializeFrameTx, simulateFrameTx, waitForFrameTxReceipt } from '../../src/exp-frames/frametx/index.js'
import * as X12 from '../17-x12-ciphertexts-in-blobs/x12.js'
import * as L from './lean.js'
import * as X from './x14.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const work = join(root, 'work')
const [runLabel, setting] = process.argv.slice(2)
if (!runLabel || !['written', 'extended'].includes(setting)) throw new Error('usage: local.ts <label> <written|extended>')
const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
const ethrexDir = join(work, 'ethrex')
const ethrexCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: ethrexDir })).trim()
const patchHash = bytesToHex(sha256(readFileSync(join(here, 'ethrex-8288.patch'))))
const { privateKey } = loadKey() // every recipient secret derives from it, as on the test network
// The payer is ethrex's first dev key, a published test key; it is not recorded.
const devKey = readFileSync(join(ethrexDir, 'fixtures/keys/private_keys_l1.txt'), 'utf8').split('\n')[0].trim() as Hex
const funder = privateKeyToAddress(devKey)
const secrets: string[] = [privateKey, devKey]
const secretBytes = (l: string, n = 32) => { const b = X.bytesOf(privateKey, l, n); secrets.push(bytesToHex(b)); return b }
const fresh = (l: string): Address => privateKeyToAddress(X.keyOf(privateKey, `fresh/${l}`))
const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n))

// ---- the node ----

const dir = join(work, `x14-local-${runLabel}`)
rmSync(dir, { recursive: true, force: true })
const witnesses = join(dir, 'witnesses')
mkdirSync(witnesses, { recursive: true })
// The genesis: ethrex's own Hegota genesis, with ERC-5564's singleton at its address, its code
// read from the test network, so payments announce exactly as there.
const genesis = JSON.parse(readFileSync(join(ethrexDir, 'fixtures/genesis/l1-hegota.json'), 'utf8'))
const singletonCode = await makeClient().getCode({ address: X12.SINGLETON })
if (!singletonCode || singletonCode === '0x') throw new Error('no singleton code on the test network')
genesis.alloc[X12.SINGLETON.toLowerCase()] = { balance: '0x0', code: singletonCode, nonce: '0x1' }
// The frame transactions carry the test network's fee caps (100 wei), so the chain starts at the
// base fee's floor rather than at 1 gwei.
genesis.baseFeePerGas = '0x7'
const genesisFile = join(dir, 'genesis.json')
writeFileSync(genesisFile, JSON.stringify(genesis))
const PORT = 18545
const node: ChildProcess = spawn(join(ethrexDir, 'target/release/ethrex'), ['--dev', '--network', genesisFile, '--datadir', join(dir, 'db'), '--http.port', String(PORT), '--authrpc.port', '18551', '--p2p.disabled', '--http.api', 'eth,net,web3,ethrex', '--log.level', 'info'], {
  env: { ...process.env, X14_EIP8288: setting, X14_PROVER: L.PROVER, X14_PROGRAMS: join(here, 'programs'), X14_WITNESS_DIR: witnesses },
  stdio: ['ignore', openSync(join(dir, 'node.out'), 'w'), openSync(join(dir, 'node.log'), 'w')],
})
node.on('exit', (code, signal) => { if (!stopping) console.log(`the node exited: ${code ?? signal}`) })
let stopping = false
const url = `http://127.0.0.1:${PORT}`
const chain = makeClient(url)
for (let i = 0; ; i++) {
  try { await chain.getBlockNumber(); break } catch { if (i > 120) throw new Error('the node did not start'); await new Promise((r) => setTimeout(r, 1000)) }
}
const chainId = BigInt(await chain.getChainId())
const local = defineChain({ id: Number(chainId), name: 'x14 local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } })
const wallet = createWalletClient({ account: privateKeyToAccount(devKey), chain: local, transport: http(url) })
console.log(`ethrex ${ethrexCommit.slice(0, 8)} patched (${setting}), chain ${chainId}, funder balance ${await chain.getBalance({ address: funder })}`)

const rows: Record<string, unknown>[] = []
const setup: Record<string, unknown>[] = []
const out: Record<string, unknown> = {}
const txs: { step: string; hash: Hex; raw: Hex }[] = []
const jsonl = (f: string) => existsSync(join(witnesses, f)) ? readFileSync(join(witnesses, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []

async function setupTx(what: string, frames: Parameters<typeof sendFrames>[2]) {
  const r = await sendFrames(chain, devKey, frames, { label: what })
  if (!r?.hash || !r.receipt) throw new Error(`${what}: not mined`)
  const ok = r.receipt.frameReceipts.every((f) => frameReceiptStatus(f) === 1)
  const row = { what, hash: r.hash, block: Number(BigInt(r.receipt.blockNumber)), gasUsed: Number(BigInt(r.receipt.gasUsed)), frames: r.receipt.frameReceipts.map((f) => ({ status: frameReceiptStatus(f), ...frameReceiptGas(f) })), ok }
  setup.push(row)
  if (!ok) throw new Error(`${what}: a frame failed`)
  return row
}
/** A dependency's witness, handed to the node before its transaction: the mode-0 wrapper's part.
 * Its file name is the dependency's key, keccak256 of scheme byte || data hash || key hash. */
function putWitness(triple: Hex, w: { signed?: L.Signed; proofFile?: string }) {
  const k = bytesToHex(keccak_256(Buffer.from(triple.slice(2 + 62), 'hex'))).slice(2)
  if (w.signed) writeFileSync(join(witnesses, `w-${k}.json`), JSON.stringify(w.signed))
  if (w.proofFile) writeFileSync(join(witnesses, `w-${k}.bin`), readFileSync(w.proofFile))
}

/** Simulate, then send; a refusal is recorded, not thrown, where `refusable` says it may come. */
async function frameStep(step: string, tx: FrameTx, extra: Record<string, unknown> = {}, refusable = false) {
  const raw = serializeFrameTx(tx)
  const hash = frameTxHash(tx)
  const sim = await simulateFrameTx(chain, tx).catch((e) => ({ valid: false, violation: (e as Error).message.slice(0, 300), executionStatus: null }))
  let sent: string | undefined
  try { await chain.request({ method: 'eth_sendRawTransaction', params: [raw] } as never) } catch (e) { sent = (e as Error).message.split('\n').slice(0, 3).join(' ').slice(0, 400) }
  if (sent) {
    const row = { step, outcome: 'refused by the node', refusal: sent, simulation: { valid: sim.valid, violation: sim.violation }, ...extra }
    console.log(`${step}: refused: ${sent.slice(0, 160)}`)
    rows.push(row)
    if (!refusable) throw new Error(`${step}: refused: ${sent}`)
    return row
  }
  const r = await waitForFrameTxReceipt(chain, hash, { timeoutMs: 180_000 })
  const frames = r.frameReceipts.map((f) => ({ status: frameReceiptStatus(f), ...frameReceiptGas(f) }))
  const ok = frames.every((f) => f.status === 1)
  const row = { step, outcome: ok ? 'mined' : 'mined, a frame failed', hash, block: Number(BigInt(r.blockNumber)), gasUsed: Number(BigInt(r.gasUsed)), frames: frames.map((f) => ({ status: f.status, execution: Number(f.execution), state: Number(f.state) })), calldataBytes: tx.frames.reduce((n, f) => n + (f.data.length - 2) / 2, 0), simulation: { valid: sim.valid, violation: sim.violation }, ...extra }
  console.log(`${step}: ${hash} block ${row.block} gasUsed ${row.gasUsed} frames ${frames.map((f) => `${f.status}:${f.execution}+${f.state}s`).join(' / ')}`)
  rows.push(row)
  txs.push({ step, hash, raw })
  if (!ok) throw new Error(`${step}: a frame failed`)
  return row
}

// ---- contracts ----

const firstBlock = (await setupTx('deploy the factory and version 5\'s pool', [X.factory.deploy, X.pool5.deploy])).block
await setupTx('version 5\'s pool float', [senderFrame({ target: X.pool5.address, value: 10n ** 15n, execution: 50_000n, state: 0n })])

// ---- the recipient, as on the test network ----

const kem = ml_kem768.keygen(secretBytes('recipient/kem', 64))
const k = secretBytes('recipient/k')
const sphincsSeed = secretBytes('recipient/sphincs')
const seeds2a = [0, 1, 2].map((i) => secretBytes(`recipient/v2a/key/${i}`))
const pks2a = seeds2a.map(L.sphincsKey)
const ZERO = new Uint8Array(32)
const DS_R = new TextEncoder().encode('exp-e2e-frames/19/r')
const DS_TAG = new TextEncoder().encode('exp-e2e-frames/19/view-tag')
function encapsulate() {
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(kem.publicKey, rnd(32))
  const r = keccak_256(Buffer.concat([DS_R, sharedSecret]))
  secrets.push(bytesToHex(r))
  return { ct: cipherText, r, viewTag: sha256(Buffer.concat([DS_TAG, sharedSecret]))[0] }
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
  return account
}
const bytes = (h: Hex) => Buffer.from(h.slice(2), 'hex')
const proofFile = (l: string) => join(dir, `proof-${l}.bin`)
const stark = setting === 'extended' // leanSTARK spends are invalid as written, and refused

// v3: the plain leanSPHINCS control, two accounts under one key.
const pkR = bytesToHex(L.sphincsKey(sphincsSeed))
async function v3Account(label: string) {
  const e = encapsulate()
  const salt = keccak256(`0x${pkR.slice(2)}${bytesToHex(e.r).slice(2)}` as Hex)
  return pay(`v3: pay and announce, ${label} account`, 3n, pkR, `0x${'00'.repeat(32)}`, salt, e.ct, e.viewTag)
}
async function v3Spend(step: string, account: Address, label: string) {
  const destination = fresh(`v3/${label}`)
  const nonce = await getNonceSeq(chain, account, [0n])
  const m = X.messageOf(account, nonce, destination, AMOUNT)
  const t = X.triple(X.LEANSPHINCS_SCHEME, m, pkR)
  putWitness(t, { signed: L.sign(sphincsSeed, bytes(m)) })
  return frameStep(step, X.spendTx(chainId, account, nonce, t, destination, AMOUNT, 'dep-frame'), { version: 3, declaredGas: X.LEANSPHINCS_VERIFICATION_GAS })
}
// v1: the preimage spend.
async function v1Account(label: string) {
  const e = encapsulate()
  const K = keccak_256(Buffer.concat([Buffer.from(k), Buffer.from(L.TAG_KEY)]))
  const C = bytesToHex(keccak_256(Buffer.concat([Buffer.from(K), Buffer.from(e.r)])))
  return { account: await pay(`v1: pay and announce, ${label}`, 1n, C, X.VK1, C, e.ct, e.viewTag), r: e.r, C }
}
async function v1Spend(step: string, a: { account: Address; r: Uint8Array }, destination: Address, label: string) {
  const nonce = await getNonceSeq(chain, a.account, [0n])
  const m = X.messageOf(a.account, nonce, destination, AMOUNT)
  const w = L.v1(k, a.r, bytes(m))
  const proof = L.prove('v1_preimage', { ...w.input, proofOut: proofFile(label) }, 0)
  const t = X.triple(X.LEANSTARK_SCHEME, bytesToHex(w.D), X.VK1)
  putWitness(t, { proofFile: proofFile(label) })
  return frameStep(step, X.spendTx(chainId, a.account, nonce, `0x${bytesToHex(w.T).slice(2)}${t.slice(2)}` as Hex, destination, AMOUNT, 'dep-frame'), { version: 1, declaredGas: X.LEANSTARK_VERIFICATION_GAS, proof: { cycles: proof.cycles, proofBytes: proof.proofBytes } }, !stark)
}

// ---- arm 1: every version but 4, paid and spent ----

const v3a = await v3Account('first')
const v3b = await v3Account('second')
await v3Spend('v3: the first account spends, under the long-term key', v3a, 'first')
await v3Spend('v3: the second account spends, under the long-term key', v3b, 'second')

const a1 = await v1Account('owner')
await v1Spend('v1: the owner spends to a fresh address', a1, fresh('v1/owner'), 'v1-owner')

for (const [label, rule] of [['one key', L.RULE_ONE], ['two of three keys', L.RULE_TWO_OF_THREE]] as const) {
  const keys = rule === L.RULE_ONE ? [pks2a[0], ZERO, ZERO] : pks2a
  const e = encapsulate()
  const C = bytesToHex(keccak_256(Buffer.concat([Buffer.from(L.ruleKeyOf(rule, keys)), Buffer.from(e.r)])))
  const account = await pay(`v2a: pay and announce, ${label}`, 2n, C, X.VK2A, C, e.ct, e.viewTag)
  const destination = fresh(rule === L.RULE_ONE ? 'v2a/one' : 'v2a/two')
  const nonce = await getNonceSeq(chain, account, [0n])
  const m = X.messageOf(account, nonce, destination, AMOUNT)
  const by = rule === L.RULE_ONE ? [0] : [2, 0]
  const w = L.v2a(rule, keys, e.r, bytes(m), by.map((index) => ({ index, signed: L.sign(seeds2a[index], bytes(m)) })))
  const file = proofFile(`v2a-${rule}`)
  const proof = L.prove('v2a_rules', { ...w.input, proofOut: file }, 0)
  const t = X.triple(X.LEANSTARK_SCHEME, bytesToHex(w.D), X.VK2A)
  putWitness(t, { proofFile: file })
  await frameStep(rule === L.RULE_ONE ? 'v2a: the owner spends, one key' : 'v2a: the owner spends, two of three keys (keys 2 and 0)', X.spendTx(chainId, account, nonce, `0x${bytesToHex(w.T).slice(2)}${t.slice(2)}` as Hex, destination, AMOUNT, 'dep-frame'), { version: 2, declaredGas: X.LEANSTARK_VERIFICATION_GAS, proof: { cycles: proof.cycles, proofBytes: proof.proofBytes } }, !stark)
}

// v5: two deposits and the owner's withdrawal.
const DEPOSIT_GAS = 23n * 97_920n + 500_000n
const notes5 = ['owner', 'delegated'].map((l) => ({ l, ns: secretBytes(`v5/${l}/ns`), s: secretBytes(`v5/${l}/s`) }))
const leaves5: Uint8Array[] = []
for (const n of notes5) {
  const c = L.leafOf(n.ns, n.s)
  const hash = await wallet.writeContract({ address: X.pool5.address, abi: X.pool5Abi, functionName: 'deposit', args: [bytesToHex(c)], value: X.DENOM, gas: DEPOSIT_GAS, maxFeePerGas: 10n ** 10n, maxPriorityFeePerGas: 1n } as never)
  const r = await chain.waitForTransactionReceipt({ hash, timeout: 180_000 })
  rows.push({ step: `v5: deposit, ${n.l}`, outcome: r.status === 'success' ? 'mined' : 'reverted', hash, block: Number(r.blockNumber), gasUsed: Number(r.gasUsed) })
  console.log(`v5: deposit, ${n.l}: gasUsed ${r.gasUsed}`)
  leaves5.push(c)
}
{
  const recipient = fresh('v5/owner')
  const binding = X.bindingOf(recipient, funder, 0n)
  const w = L.v5(notes5[0].ns, notes5[0].s, bytes(binding), L.treeOf(leaves5), 0)
  const file = proofFile('v5-owner')
  const proof = L.prove('v5_tornado', { ...w.input, proofOut: file }, 0)
  const t = X.triple(X.LEANSTARK_SCHEME, bytesToHex(w.D), X.VK5)
  putWitness(t, { proofFile: file })
  await frameStep('v5: the owner withdraws to a fresh address', X.withdraw5Tx(chainId, bytesToHex(w.nf), t, bytesToHex(w.root), recipient, funder, 0n, 'dep-frame'), { version: 5, declaredGas: X.LEANSTARK_VERIFICATION_GAS, proof: { cycles: proof.cycles, proofBytes: proof.proofBytes } }, !stark)
}

// ---- arm 6: two bad blocks ----

/** The switch is set, a spend sent, and the node's own record read back for that block. */
async function badBlock(mode: 'omit' | 'other', step: string, send: () => Promise<Record<string, unknown>>) {
  const before = jsonl('checks.jsonl').length
  writeFileSync(join(witnesses, 'corrupt'), mode)
  const row = await send()
  const checks = jsonl('checks.jsonl').slice(before)
  const builds = jsonl('builds.jsonl').filter((b) => b.corrupt === mode)
  const refused = checks.filter((c) => !c.valid)
  const accepted = checks.filter((c) => c.valid)
  const result = { mode, step, refusedBlocks: refused, acceptedAfter: accepted.slice(0, 1), corruptBuild: builds.slice(-1), minedIn: row.block, refused: refused.length > 0 && accepted.length > 0 }
  console.log(`arm 6, ${mode}: ${JSON.stringify(result).slice(0, 400)}`)
  return result
}
const other = L.sign(rnd(32), rnd(32))
writeFileSync(join(witnesses, 'other.json'), JSON.stringify(other))
const v3c = await v3Account('third')
const v3d = await v3Account('fourth')
const arm6: unknown[] = []
arm6.push(await badBlock('omit', 'v3: a spend whose block proof omits its dependency', () => v3Spend('v3: the third account spends (bad block: omit)', v3c, 'third')))
arm6.push(await badBlock('other', 'v3: a spend whose block proof is for another dependency', () => v3Spend('v3: the fourth account spends (bad block: other)', v3d, 'fourth')))
if (stark) {
  // A proof of another statement, for the leanSTARK half.
  const decoy = L.v1(rnd(32), rnd(32), rnd(32))
  L.prove('v1_preimage', { ...decoy.input, proofOut: join(witnesses, 'other.bin') }, 0)
  const b1 = await v1Account('bad block, omit')
  arm6.push(await badBlock('omit', 'v1: a spend whose block proof omits its dependency', () => v1Spend('v1: a spend (bad block: omit)', b1, fresh('v1/bad-omit'), 'v1-bad-omit')))
  const b2 = await v1Account('bad block, other')
  arm6.push(await badBlock('other', 'v1: a spend whose block proof is for another statement', () => v1Spend('v1: a spend (bad block: other)', b2, fresh('v1/bad-other'), 'v1-bad-other')))
}
out.arm6 = arm6

// ---- prediction 5: each transaction against its modelled figure ----

const modelled = new Map<string, { gasUsed: number; declaredGas?: number }>()
for (const f of ['2-part2-testnet.json', '2-part2-testnet-v2a.json']) {
  const file = join(here, 'results', f)
  if (!existsSync(file)) continue
  for (const r of JSON.parse(readFileSync(file, 'utf8')).rows as { step: string; gasUsed: number; declaredGas?: number }[]) modelled.set(r.step, r)
}
out.prediction5 = rows.filter((r) => typeof r.gasUsed === 'number' && modelled.has(r.step as string)).map((r) => {
  const m = modelled.get(r.step as string)!
  const expected = m.gasUsed + (m.declaredGas ?? 0)
  return { step: r.step, local: r.gasUsed, modelled: expected, measuredThere: m.gasUsed, declared: m.declaredGas ?? 0, difference: (r.gasUsed as number) - expected }
})
console.log(`prediction 5: ${JSON.stringify(out.prediction5)}`)

stopping = true
node.kill('SIGTERM')
const lastBlock = Number(await chain.getBlockNumber().catch(() => 0n))

// ---- the record ----

const record = {
  experiment: 19, run: runLabel, setting, deployment: X.DEPLOYMENT, repoCommit, chainId: Number(chainId), funder,
  ethrex: { commit: ethrexCommit, patch: 'ethrex-8288.patch', patchSha256: patchHash, genesis: 'fixtures/genesis/l1-hegota.json, with ERC-5564\'s singleton added at its address' },
  contracts: { factory: X.factory.address, pool5: X.pool5.address, singleton: X12.SINGLETON },
  vk: { v1: X.VK1, v5: X.VK5, v2a: X.VK2A },
  blocks: { first: firstBlock, last: lastBlock }, setup, rows, ...out,
  nodeRecords: { builds: jsonl('builds.jsonl'), checks: jsonl('checks.jsonl') },
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
