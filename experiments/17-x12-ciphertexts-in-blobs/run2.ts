// Experiment 17 (X12), run 2: blobs behind ERC-5564's singleton announcer, on the test network.
//   1. Ten direct announcements through the singleton, five to our recipient, each with ERC-5564's
//      57 bytes of metadata.
//   2. One blob of 102 announcements of kind 3 (each carrying its metadata), 20 to our recipient,
//      posted by Board2, whose SENDER frame announces a pointer to it through the singleton.
//   3. One pointer sent through the singleton by an account that is not a board.
// Arm 4, offline, is scan2.ts. Before anything is sent, the singleton's code on the test network
// is read and compared with mainnet's. The record is results/<n>-<label>.json and the fixture
// test/fixtures/x12/<n>-<label>.json, after a search for every secret.
//
// usage: X12_DEPLOYMENT=<tag> npx tsx experiments/17-x12-ciphertexts-in-blobs/run2.ts <n>-<label>
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1'
import { type Hex, bytesToHex, concatHex, decodeEventLog, hexToBigInt, keccak256, numberToHex, zeroAddress } from 'viem'
import { type Pin, loadKey, run } from '../../src/e2e/index.js'
import { sendFrames } from '../../src/exp-frames/deploy.js'
import { type FrameTx, frameReceiptGas, frameReceiptStatus, frameTxHash, getNonceSeq, makeClient, senderFrame, serializeFrameTx, simulateFrameTx, waitForFrameTxReceipt } from '../../src/exp-frames/frametx/index.js'
import { STORAGE_SET_STATE_GAS } from '../../src/exp-frames/frametx/index.js'
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { hegotaTestnet } from '../../src/exp-frames/frametx/index.js'
import * as B from './blob.js'
import * as P from './payloads.js'
import * as X from './x12.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const runLabel = process.argv[2]
if (!runLabel || !/^\d+-[a-z0-9-]+$/.test(runLabel)) throw new Error('usage: run2.ts <n>-<label>')
mkdirSync(join(here, 'results'), { recursive: true })
mkdirSync(join(root, 'test/fixtures/x12'), { recursive: true })
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8')) as Record<string, Pin>
const { privateKey, address: funder } = loadKey()
const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
const dirty = (await run('git', ['status', '--porcelain', '--', X.DIR, 'src'], { cwd: root })).trim()
if (dirty) throw new Error(`commit the experiment before a recorded run:\n${dirty}`)

const chain = makeClient()
const chainId = BigInt(await chain.getChainId())
const C = X.contractsOf(privateKey)
const packerKey = X.keyOf(privateKey, 'packer')
const wallet = createWalletClient({ account: privateKeyToAccount(privateKey), chain: hegotaTestnet, transport: http() })
const sSeed = X.seedOf(privateKey, 'recipient/s', 128)
const secretStrings: string[] = [privateKey, packerKey, bytesToHex(sSeed), bytesToHex(sSeed.subarray(0, 32)), bytesToHex(sSeed.subarray(32, 64))]

type Row = Record<string, unknown>
const rows: Row[] = []
const setup: Row[] = []
const out: Record<string, unknown> = {}

// ---- prices and the singleton's code, before anything is sent ----

async function rpcOf(url: string, method: string, params: unknown[]) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const body = await r.json()
  if (body.error || body.result === undefined) throw new Error(`${url} ${method}: ${JSON.stringify(body.error ?? body)}`)
  return body.result
}
const TESTNET = 'https://rpc1.privacy.ethrex.xyz'
const MAINNET = 'https://ethereum-rpc.publicnode.com'
async function pricesOf(url: string) {
  const blk = await rpcOf(url, 'eth_getBlockByNumber', ['latest', false])
  return { url, block: Number(BigInt(blk.number)), baseFeePerGas: BigInt(blk.baseFeePerGas).toString(), blobBaseFee: BigInt(await rpcOf(url, 'eth_blobBaseFee', [])).toString() }
}
out.prices = { testnet: await pricesOf(TESTNET), mainnet: await pricesOf(MAINNET) }
out.client = await chain.request({ method: 'web3_clientVersion' } as never)
{
  const codeOf = async (url: string) => {
    const block = await rpcOf(url, 'eth_blockNumber', [])
    const code = (await rpcOf(url, 'eth_getCode', [X.SINGLETON, block])) as Hex
    return { block: Number(BigInt(block)), bytes: (code.length - 2) / 2, sha256: createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex') }
  }
  const t = await codeOf(TESTNET)
  const m = await codeOf(MAINNET)
  out.singleton = { address: X.SINGLETON, testnet: t, mainnet: m, identical: t.bytes > 0 && t.sha256 === m.sha256 }
  console.log(`singleton: ${t.bytes} bytes on the test network, ${m.bytes} on mainnet, identical ${t.sha256 === m.sha256}`)
  if (t.sha256 !== m.sha256 || t.bytes === 0) throw new Error('the singleton is not mainnet\'s on the test network')
}

// ---- set-up ----

async function setupTx(what: string, frames: Parameters<typeof sendFrames>[2]) {
  const r = await sendFrames(chain, privateKey, frames, { label: what })
  if (!r?.hash || !r.receipt) throw new Error(`${what}: not mined`)
  const ok = r.receipt.frameReceipts.every((f) => frameReceiptStatus(f) === 1)
  setup.push({ what, hash: r.hash, block: Number(BigInt(r.receipt.blockNumber)), gasUsed: Number(BigInt(r.receipt.gasUsed)), ok })
  if (!ok) throw new Error(`${what}: a frame failed`)
  return Number(BigInt(r.receipt.blockNumber))
}
console.log(`deployment ${X.DEPLOYMENT}: board2 ${C.board2.address}`)
{
  const code = await chain.getCode({ address: C.board2.address })
  if (code && code !== '0x') throw new Error('board2 is already deployed: set X12_DEPLOYMENT to a fresh tag')
}
const firstBlock = await setupTx('deploy board2', [C.board2.deploy])
await setupTx('board2\'s deposit', [senderFrame({ target: C.board2.address, value: 10n ** 16n, execution: 50_000n, state: STORAGE_SET_STATE_GAS })])

// ---- the payloads ----

const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n))
const otherRecipient = () => { for (;;) { try { return P.keygen(rnd(128)).recipient } catch { /* draw again */ } } }
const me = P.keygen(sSeed)
/** transfer(address,uint256), a token address and an amount: ERC-5564's recommended metadata after the view tag. */
const SELECTOR = Uint8Array.of(0xa9, 0x05, 0x9c, 0xbb)
const metaFor = (viewTag: number) => P.metadataOf(viewTag, SELECTOR, rnd(20), rnd(32))

const OURS_DIRECT = [1, 3, 5, 7, 9]
const direct = Array.from({ length: 10 }, (_, i) => {
  const a = P.announce(OURS_DIRECT.includes(i) ? me.recipient : otherRecipient(), secp256k1.utils.randomPrivateKey(), rnd(32))
  return { stealthAddress: a.stealthAddress, epkCt: P.cat(a.epk, a.ct), metadata: metaFor(a.viewTag) }
})
const OURS_BLOB = Array.from({ length: 20 }, (_, k) => 2 + 5 * k)
const blobEntries = Array.from({ length: B.capacity(P.S2_BYTES) }, (_, i) => {
  const a = P.announce(OURS_BLOB.includes(i) ? me.recipient : otherRecipient(), secp256k1.utils.randomPrivateKey(), rnd(32))
  return P.encodeS2(a, metaFor(a.viewTag))
})
{
  const foundDirect = direct.flatMap((d, i) => (P.scanS(me.tracking, P.cat(d.stealthAddress, d.epkCt, d.metadata.subarray(0, 1))) ? [i] : []))
  const foundBlob = blobEntries.flatMap((e, i) => (P.scanS2(me.tracking, e) ? [i] : []))
  if (foundDirect.join() !== OURS_DIRECT.join() || foundBlob.join() !== OURS_BLOB.join()) throw new Error(`the recipient found ${foundDirect} and ${foundBlob}`)
}
const blob = B.packBlob(B.KIND.S2, blobEntries)
const sidecar = B.sidecarOf([blob])
const commitment = sidecar.commitments[0]
const vh = B.versionedHashOf(commitment)
const header = hexToBigInt(bytesToHex(B.element(blob, 0)))
out.blob = { vh, entries: blobEntries.length, entryBytes: P.S2_BYTES, ours: OURS_BLOB, header: numberToHex(header, { size: 32 }) }

// ---- arm 1: direct announcements through the singleton ----

async function eoaTx(step: string, hash: Hex, extra: Row = {}) {
  const r = await chain.waitForTransactionReceipt({ hash, timeout: 180_000 })
  const tx = await chain.getTransaction({ hash })
  const row = { step, outcome: r.status === 'success' ? 'mined' : 'reverted', hash, block: Number(r.blockNumber), gasUsed: Number(r.gasUsed), calldataBytes: (tx.input.length - 2) / 2, ...extra }
  console.log(`${step}: ${hash} block ${row.block} gasUsed ${row.gasUsed} calldata ${row.calldataBytes}`)
  rows.push(row)
  if (r.status !== 'success') throw new Error(`${step}: reverted`)
  return row
}
for (let i = 0; i < direct.length; i++) {
  const d = direct[i]
  await eoaTx(`direct: announcement ${i} through the singleton`, await wallet.writeContract({ address: X.SINGLETON, abi: X.singletonAbi, functionName: 'announce', args: [3n, bytesToHex(d.stealthAddress), bytesToHex(d.epkCt), bytesToHex(d.metadata)] } as never), { index: i, ours: OURS_DIRECT.includes(i) })
}

// ---- arm 2: board2 posts the blob and announces a pointer ----

const minedFrameTxs: { step: string; hash: Hex; raw: Hex }[] = []
async function postStep(step: string, tx: FrameTx) {
  let sim = await simulateFrameTx(chain, tx)
  for (let i = 0; (!sim.valid || sim.executionStatus !== 'success') && i < 10; i++) {
    await new Promise((res) => setTimeout(res, 6_000))
    sim = await simulateFrameTx(chain, tx)
  }
  const simRow = { valid: sim.valid, violation: sim.violation, executionStatus: sim.executionStatus, gasUsed: sim.gasUsed ? Number(BigInt(sim.gasUsed)) : null, frames: sim.frames?.map((f) => ({ gasUsed: Number(BigInt(f.gasUsed)), succeeded: f.succeeded })) }
  if (!sim.valid || sim.executionStatus !== 'success') throw new Error(`${step}: simulation does not admit it: ${JSON.stringify(simRow)}`)
  const hash = frameTxHash(tx)
  const sent = (await chain.request({ method: 'eth_sendRawTransaction', params: [B.frameTxWithBlobs(tx, sidecar)] } as never)) as Hex
  if (sent.toLowerCase() !== hash.toLowerCase()) throw new Error(`${step}: the node returned ${sent}, not ${hash}`)
  const r = await waitForFrameTxReceipt(chain, hash, { timeoutMs: 180_000 })
  const frames = r.frameReceipts.map((f) => ({ status: frameReceiptStatus(f), ...frameReceiptGas(f) }))
  const ok = frames.every((f) => f.status === 1)
  const row = { step, outcome: ok ? 'mined' : 'mined, a frame failed', hash, block: Number(BigInt(r.blockNumber)), gasUsed: Number(BigInt(r.gasUsed)), calldataBytes: (tx.frames[1].data.length - 2) / 2, frames: frames.map((f) => ({ status: f.status, execution: Number(f.execution), state: Number(f.state) })), simulation: simRow }
  console.log(`${step}: ${hash} block ${row.block} gasUsed ${row.gasUsed} frames ${frames.map((f) => `${f.status}:${f.execution}+${f.state}s`).join(' / ')}`)
  rows.push(row)
  minedFrameTxs.push({ step, hash, raw: serializeFrameTx(tx) })
  if (!ok) throw new Error(`${step}: a frame failed`)
  return row
}
// record() now also calls the singleton: run 1's 100,000 execution with room for the call.
const SENDER_GAS = { execution: 130_000n, state: 4n * STORAGE_SET_STATE_GAS }
const { proof } = B.openElement(blob, 0)
const w = await X.postWords(packerKey, chainId, C.board2.address, vh, header, X.POST_FEE, commitment, proof)
const postRow = await postStep('post: board2 records the blob of 102 announcements and announces a pointer', X.postTx(chainId, C.board2.address, w, [vh], await getNonceSeq(chain, C.board2.address, [0n]), SENDER_GAS))
const count = await X.settled('count()', async () => (await chain.readContract({ address: C.board2.address, abi: X.boardAbi, functionName: 'count' })) as bigint)

// ---- arm 3: a pointer from an account that is not a board ----

const pointerKey = concatHex([vh, numberToHex(header & ((1n << 248n) - 1n), { size: 31 })])
const pointerMeta = concatHex(['0x00', numberToHex(count, { size: 8 })])
await eoaTx('spoof: a pointer through the singleton from an account that is not a board', await wallet.writeContract({ address: X.SINGLETON, abi: X.singletonAbi, functionName: 'announce', args: [3n, zeroAddress, pointerKey, pointerMeta] } as never))
const lastBlock = Number(await chain.getBlockNumber())

// ---- the singleton's events over the run ----

const logs = await X.settled('logs', async () => {
  const ls = await chain.getLogs({ address: X.SINGLETON, fromBlock: BigInt(firstBlock), toBlock: BigInt(lastBlock) })
  return ls.length >= 12 ? ls : undefined
})
const events = logs.map((l) => {
  const e = decodeEventLog({ abi: X.singletonAbi, data: l.data, topics: l.topics }) as unknown as { args: { schemeId: bigint; stealthAddress: Hex; caller: Hex; ephemeralPubKey: Hex; metadata: Hex } }
  return { block: Number(l.blockNumber), tx: l.transactionHash, schemeId: Number(e.args.schemeId), stealthAddress: e.args.stealthAddress, caller: e.args.caller, ephemeralPubKey: e.args.ephemeralPubKey, metadata: e.args.metadata }
})
const boardPointer = events.find((e) => e.caller.toLowerCase() === C.board2.address.toLowerCase())
if (!boardPointer) throw new Error('no pointer from board2 among the singleton\'s events')
if (boardPointer.ephemeralPubKey.toLowerCase() !== pointerKey.toLowerCase() || boardPointer.metadata.toLowerCase() !== pointerMeta.toLowerCase()) throw new Error(`board2's pointer is ${JSON.stringify(boardPointer)}`)
out.pointer = { fromBoard: boardPointer, expected: { ephemeralPubKey: pointerKey, metadata: pointerMeta }, postCount: Number(count) }
console.log(`board2's pointer: block ${boardPointer.block}, ${(boardPointer.ephemeralPubKey.length - 2) / 2}-byte key, metadata ${boardPointer.metadata}`)

// ---- the record ----

const record = {
  experiment: 17, run: runLabel, deployment: X.DEPLOYMENT, repoCommit, chainId: Number(chainId), funder,
  contracts: { board2: C.board2.address, singleton: X.SINGLETON, packer: C.packer },
  blocks: { first: firstBlock, last: lastBlock }, pins, setup, rows, ...out,
  post: { verify: postRow.frames[0], sender: postRow.frames[1], gasUsed: postRow.gasUsed },
}
const fixture = {
  chainId: Number(chainId), board2: C.board2.address, packer: C.packer, singleton: X.SINGLETON,
  blocks: { first: firstBlock, last: lastBlock },
  direct: direct.map((d, i) => ({ index: i, stealthAddress: bytesToHex(d.stealthAddress), ephemeralPubKey: bytesToHex(d.epkCt), metadata: bytesToHex(d.metadata), ours: OURS_DIRECT.includes(i) })),
  blob: { vh, header: numberToHex(header, { size: 32 }), seq: Number(count) - 1, entries: blobEntries.map((e) => bytesToHex(e)), ours: OURS_BLOB, commitment: bytesToHex(commitment) },
  events, transactions: minedFrameTxs,
}
for (const [name, body] of [['record', JSON.stringify(record)], ['fixture', JSON.stringify(fixture)]] as const) {
  for (const s of secretStrings) {
    const bare = s.replace(/^0x/, '').toLowerCase()
    if (bare.length >= 32 && body.toLowerCase().includes(bare)) throw new Error(`the ${name} contains a secret; not written`)
  }
}
writeFileSync(join(here, 'results', `${runLabel}.json`), JSON.stringify(record, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n')
writeFileSync(join(root, 'test/fixtures/x12', `${runLabel}.json`), JSON.stringify(fixture, null, 1) + '\n')
console.log(`recorded results/${runLabel}.json and test/fixtures/x12/${runLabel}.json; keccak of the blob's entries ${keccak256(concatHex(blobEntries.map((e) => bytesToHex(e))))}`)
