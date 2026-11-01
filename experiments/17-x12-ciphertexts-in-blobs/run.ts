// Experiment 17 (X12): ciphertexts in blobs, on the test network. Arms 1 to 4:
//   1. each payload as a log, and a blob of each carried by a plain type-3 transaction;
//   2. the Board posting each blob in its own frame transaction, after a skandha node's answer is
//      recorded, and three posts it must refuse;
//   3. one entry proved in a posted blob, and the same proof over a changed entry;
//   4. archivers challenged: one answers, one cannot and is slashed, a wrong answer reverts.
// Every frame transaction is simulated first, and sent only if the simulation says what the step
// expects. Arm 5, scanning, is scan.ts. The record is written to results/<n>-<label>.json and the
// mined transactions to test/fixtures/x12/, after a search for every secret.
//
// usage: X12_DEPLOYMENT=<tag> npx tsx experiments/17-x12-ciphertexts-in-blobs/run.ts <n>-<label>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1'
import { type Address, type Hex, bytesToHex, createWalletClient, decodeEventLog, encodeFunctionData, hexToBigInt, http, keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { type Pin, buildSkandha, checkout, linesNaming, loadKey, rpcUrlOf, run, startNode, stopNode, until, writeConfig } from '../../src/e2e/index.js'
import { sendFrames } from '../../src/exp-frames/deploy.js'
import { type FrameTx, frameReceiptGas, frameReceiptStatus, frameTxHash, hegotaTestnet, makeClient, senderFrame, serializeFrameTx, simulateFrameTx, waitForFrameTxReceipt } from '../../src/exp-frames/frametx/index.js'
import * as B from './blob.js'
import * as P from './payloads.js'
import * as X from './x12.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const work = join(root, 'work')
const runLabel = process.argv[2]
if (!runLabel || !/^\d+-[a-z0-9-]+$/.test(runLabel)) throw new Error('usage: run.ts <n>-<label>')
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
const archiverKey = { A: X.keyOf(privateKey, 'archiver/A'), B: X.keyOf(privateKey, 'archiver/B') }
const archiver = { A: privateKeyToAccount(archiverKey.A).address, B: privateKeyToAccount(archiverKey.B).address }
const walletOf = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain: hegotaTestnet, transport: http() })
const wallet = walletOf(privateKey)

// Every secret of the run, searched for in the record before it is written.
const secretStrings: string[] = [privateKey, packerKey, archiverKey.A, archiverKey.B]
const sSeed = X.seedOf(privateKey, 'recipient/s', 128)
const nSeed = X.seedOf(privateKey, 'recipient/n', 64)
secretStrings.push(bytesToHex(sSeed), bytesToHex(nSeed), bytesToHex(sSeed.subarray(0, 32)), bytesToHex(sSeed.subarray(32, 64)), bytesToHex(nSeed.subarray(0, 32)))

type Row = Record<string, unknown>
const rows: Row[] = []
const setup: Row[] = []
const out: Record<string, unknown> = {}
const fixtures: Record<string, unknown> = {}

// ---- prices, read during the run ----

async function pricesOf(url: string) {
  const call = async (method: string, params: unknown[]) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    const body = await r.json()
    if (body.error || body.result === undefined) throw new Error(`${url} ${method}: ${JSON.stringify(body.error ?? body)}`)
    return body.result
  }
  const blk = await call('eth_getBlockByNumber', ['latest', false])
  return { url, block: Number(BigInt(blk.number)), baseFeePerGas: BigInt(blk.baseFeePerGas).toString(), blobBaseFee: BigInt(await call('eth_blobBaseFee', [])).toString() }
}
// drpc's free plan refuses eth_blobBaseFee, so mainnet's prices come from publicnode.
out.prices = { testnet: await pricesOf('https://rpc1.privacy.ethrex.xyz'), mainnet: await pricesOf('https://ethereum-rpc.publicnode.com') }
out.client = await chain.request({ method: 'web3_clientVersion' } as never)

// ---- set-up, to the chain directly ----

async function setupTx(what: string, key: Hex, frames: Parameters<typeof sendFrames>[2]) {
  const r = await sendFrames(chain, key, frames, { label: what })
  if (!r?.hash || !r.receipt) throw new Error(`${what}: not mined`)
  const ok = r.receipt.frameReceipts.every((f) => frameReceiptStatus(f) === 1)
  setup.push({ what, hash: r.hash, block: Number(BigInt(r.receipt.blockNumber)), gasUsed: Number(BigInt(r.receipt.gasUsed)), ok })
  if (!ok) throw new Error(`${what}: a frame failed`)
}
console.log(`deployment ${X.DEPLOYMENT}: board ${C.board.address}, archive ${C.archive.address}, announcer ${C.announcer.address}`)
{
  const code = await chain.getCode({ address: C.board.address })
  if (code && code !== '0x') throw new Error('the board is already deployed: set X12_DEPLOYMENT to a fresh tag')
}
await setupTx('deploy the announcer, the board and the archive', privateKey, [C.announcer.deploy, C.board.deploy, C.archive.deploy])
const DEPOSIT = 10n ** 16n
await setupTx('the board\'s deposit, and ether for the two archivers', privateKey, [
  senderFrame({ target: C.board.address, value: DEPOSIT, execution: 50_000n, state: 0n }),
  senderFrame({ target: archiver.A, value: 10n ** 16n, execution: 30_000n, state: 183_600n }),
  senderFrame({ target: archiver.B, value: 10n ** 16n, execution: 30_000n, state: 183_600n }),
])
const bondCall = senderFrame({ target: C.archive.address, data: encodeFunctionData({ abi: X.archiveAbi, functionName: 'bond' }), value: X.BOND, execution: 60_000n, state: 97_920n })
await setupTx('archiver A bonds', archiverKey.A, [bondCall])
await setupTx('archiver B bonds', archiverKey.B, [bondCall])
const readC = <T>(address: Address, abi: unknown, functionName: string, args: unknown[] = []) =>
  X.settled(`${functionName}()`, async () => (await chain.readContract({ address, abi, functionName, args } as never)) as T)
if ((await readC<Address>(C.board.address, X.boardAbi, 'packer')).toLowerCase() !== C.packer.toLowerCase()) throw new Error('the board names another packer')

// ---- the payloads: ours among others', with randomness drawn here ----

const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n))
const otherRecipient = () => { for (;;) { try { return P.keygen(rnd(128)).recipient } catch { /* draw again */ } } }
const me = P.keygen(sSeed)
const meN = P.noteKeygen(nSeed)
const OURS_S = [3, 40, 77, 106]
const OURS_N = [5, 50, 99, 104]
const sEntries = Array.from({ length: B.capacity(P.S_BYTES) }, (_, i) =>
  P.encodeS(P.announce(OURS_S.includes(i) ? me.recipient : otherRecipient(), secp256k1.utils.randomPrivateKey(), rnd(32))))
const nEntries = Array.from({ length: B.capacity(P.N_BYTES) }, (_, i) =>
  P.sealNote(OURS_N.includes(i) ? meN.ek : P.noteKeygen(rnd(64)).ek, rnd(64), rnd(32)))
// Our recipient finds exactly its own entries before anything is posted.
const foundS = sEntries.flatMap((e, i) => (P.scanS(me.tracking, e) ? [i] : []))
const foundN = nEntries.flatMap((e, i) => (P.scanN(meN.dk, e) ? [i] : []))
if (foundS.join() !== OURS_S.join() || foundN.join() !== OURS_N.join()) throw new Error(`the recipient found ${foundS} and ${foundN}`)

type Posted = { kind: B.Kind; blob: Uint8Array; entries: Uint8Array[]; sidecar: B.Sidecar; vh: Hex; header: bigint; commitment: Uint8Array }
function blobOf(kind: B.Kind, entries: Uint8Array[]): Posted {
  const blob = B.packBlob(kind, entries)
  const sidecar = B.sidecarOf([blob])
  const commitment = sidecar.commitments[0]
  return { kind, blob, entries, sidecar, vh: B.versionedHashOf(commitment), header: hexToBigInt(bytesToHex(B.element(blob, 0))), commitment }
}
const S = blobOf(B.KIND.S, sEntries)
const N = blobOf(B.KIND.N, nEntries)
out.blobs = { S: { vh: S.vh, entries: sEntries.length, ours: OURS_S }, N: { vh: N.vh, entries: nEntries.length, ours: OURS_N } }

// ---- arm 1: logs, and blobs on plain type-3 transactions ----

async function eoaTx(step: string, hash: Hex, extra: Row = {}) {
  const r = await chain.waitForTransactionReceipt({ hash, timeout: 180_000 })
  const tx = await chain.getTransaction({ hash })
  const row = { step, outcome: r.status === 'success' ? 'mined' : 'reverted', hash, block: Number(r.blockNumber), gasUsed: Number(r.gasUsed), calldataBytes: (tx.input.length - 2) / 2, blobGasUsed: r.blobGasUsed ? Number(r.blobGasUsed) : undefined, blobGasPrice: r.blobGasPrice ? r.blobGasPrice.toString() : undefined, ...extra }
  console.log(`${step}: ${hash} block ${row.block} gasUsed ${row.gasUsed}${row.blobGasUsed ? ` blobGas ${row.blobGasUsed}` : ''}`)
  rows.push(row)
  if (r.status !== 'success') throw new Error(`${step}: reverted`)
  return row
}

await eoaTx('intrinsic: a plain transfer of nothing to oneself', await wallet.sendTransaction({ to: funder, value: 0n }))
for (const i of [0, 1, 2]) {
  const e = sEntries[i]
  await eoaTx(`log: one ERC-8441 announcement (entry ${i})`, await wallet.writeContract({ address: C.announcer.address, abi: X.announcerAbi, functionName: 'announce', args: [3n, bytesToHex(e.subarray(0, 20)), bytesToHex(e.subarray(20, 1141)), bytesToHex(e.subarray(1141))] } as never), { kind: 'S' })
}
await eoaTx('log: one encrypted note (entry 0)', await wallet.writeContract({ address: C.announcer.address, abi: X.announcerAbi, functionName: 'announceNote', args: [bytesToHex(nEntries[0])] } as never), { kind: 'N' })

async function blobTx(step: string, p: Posted) {
  const account = privateKeyToAccount(privateKey)
  const nonce = await chain.getTransactionCount({ address: funder, blockTag: 'pending' })
  const signed = await account.signTransaction({ type: 'eip4844', chainId: Number(chainId), nonce, to: funder, value: 0n, data: '0x', gas: 50_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 1n, maxFeePerBlobGas: 100n, blobVersionedHashes: [p.vh] })
  const hash = (await chain.request({ method: 'eth_sendRawTransaction', params: [B.blobTxWithBlobs(signed, p.sidecar)] } as never)) as Hex
  if (hash.toLowerCase() !== keccak256(signed).toLowerCase()) throw new Error(`${step}: the node returned another hash`)
  return eoaTx(step, hash, { kind: p.kind === B.KIND.S ? 'S' : 'N', entries: p.entries.length, vh: p.vh, payload: signed })
}
await blobTx('blob: 107 announcements on a plain type-3 transaction', S)
await blobTx('blob: 105 encrypted notes on a plain type-3 transaction', N)

// ---- arm 2: the Board posts its own blobs ----

const minedFrameTxs: { step: string; hash: Hex; raw: Hex }[] = []
async function postStep(step: string, tx: FrameTx, sidecar: B.Sidecar | undefined, expect: 'mined' | 'refused', extra: Row = {}) {
  let sim = await simulateFrameTx(chain, tx)
  for (let i = 0; expect === 'mined' && (!sim.valid || sim.executionStatus !== 'success') && i < 10; i++) {
    await new Promise((res) => setTimeout(res, 6_000))
    sim = await simulateFrameTx(chain, tx)
  }
  const simRow = { valid: sim.valid, violation: sim.violation, executionStatus: sim.executionStatus, gasUsed: sim.gasUsed ? Number(BigInt(sim.gasUsed)) : null, frames: sim.frames?.map((f) => ({ gasUsed: Number(BigInt(f.gasUsed)), succeeded: f.succeeded })) }
  const hash = frameTxHash(tx)
  const raw = sidecar ? B.frameTxWithBlobs(tx, sidecar) : serializeFrameTx(tx)
  if (expect === 'refused') {
    if (sim.valid) throw new Error(`${step}: expected a refusal, but simulation admits it (${JSON.stringify(simRow)})`)
    let answer = 'admitted'
    try {
      await chain.request({ method: 'eth_sendRawTransaction', params: [raw] } as never)
    } catch (e) {
      answer = (e as Error).message.split('\n')[0].slice(0, 200)
    }
    if (answer === 'admitted') throw new Error(`${step}: the chain's RPC admitted what simulation refused`)
    console.log(`${step}: refused (${sim.violation}); the chain's RPC: ${answer}`)
    rows.push({ step, expect, outcome: 'refused', hash, simulation: simRow, rpc: answer, ...extra })
    return undefined
  }
  if (!sim.valid || sim.executionStatus !== 'success') throw new Error(`${step}: simulation does not admit it: ${JSON.stringify(simRow)}`)
  const sent = (await chain.request({ method: 'eth_sendRawTransaction', params: [raw] } as never)) as Hex
  if (sent.toLowerCase() !== hash.toLowerCase()) throw new Error(`${step}: the node returned ${sent}, not ${hash}`)
  const r = await waitForFrameTxReceipt(chain, hash, { timeoutMs: 180_000 })
  const frames = r.frameReceipts.map((f) => ({ status: frameReceiptStatus(f), ...frameReceiptGas(f) }))
  const ok = frames.every((f) => f.status === 1)
  const row = { step, expect, outcome: ok ? 'mined' : 'mined, a frame failed', hash, block: Number(BigInt(r.blockNumber)), gasUsed: Number(BigInt(r.gasUsed)), blobGasUsed: (r as { blobGasUsed?: Hex }).blobGasUsed ? Number(BigInt((r as { blobGasUsed?: Hex }).blobGasUsed!)) : undefined, calldataBytes: (tx.frames[1].data.length - 2) / 2, frames: frames.map((f) => ({ status: f.status, execution: Number(f.execution), state: Number(f.state) })), simulation: simRow, ...extra }
  console.log(`${step}: ${hash} block ${row.block} gasUsed ${row.gasUsed} frames ${frames.map((f) => `${f.status}:${f.execution}+${f.state}s`).join(' / ')}`)
  rows.push(row)
  minedFrameTxs.push({ step, hash, raw: serializeFrameTx(tx) })
  if (!ok) throw new Error(`${step}: a frame failed`)
  return row
}

async function post(p: Posted, header = p.header, key = X.postKey(p.vh)) {
  const { proof } = B.openElement(p.blob, 0)
  const w = await X.postWords(packerKey, chainId, C.board.address, p.vh, header, X.POST_FEE, p.commitment, proof)
  return X.postTx(chainId, C.board.address, w, [p.vh], key)
}

// The open node's answer first: skandha at its pin, one node, the transaction sent to it alone.
{
  const skandha = await checkout('skandha', pins.skandha, work)
  await buildSkandha(skandha)
  const stamp = Date.now()
  const config = join(work, `x12-${stamp}.json`)
  writeConfig(config)
  const log = join(work, `a-${stamp}.frames.jsonl`)
  const a = await startNode({ dir: skandha, name: 'A', config, dataDir: join(work, `a-${stamp}`), apiPort: 15337, wsPort: 15437, p2pPort: 15000, log, out: join(work, `a-${stamp}.out`) })
  try {
    const tx = await post(S)
    let answer = 'admitted'
    try {
      const res = await fetch(rpcUrlOf(a), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [B.frameTxWithBlobs(tx, S.sidecar)] }) })
      const body = await res.json()
      answer = body.error ? JSON.stringify(body.error).slice(0, 300) : `admitted: ${body.result}`
    } catch (e) {
      answer = `unreachable: ${(e as Error).message.slice(0, 200)}`
    }
    const logged = await until('node A\'s line', async () => {
      const ls = linesNaming(log, frameTxHash(tx))
      return ls.length > 0 ? ls : undefined
    }, 10_000).catch(() => [])
    console.log(`skandha at ${pins.skandha.commit.slice(0, 7)}: ${answer}`)
    out.skandha = { commit: pins.skandha.commit, answer, logged }
  } finally {
    await stopNode(a.child)
  }
}

const postS = await postStep('post: the board records the blob of 107 announcements', await post(S), S.sidecar, 'mined', { kind: 'S', vh: S.vh })
const postN = await postStep('post: the board records the blob of 105 encrypted notes', await post(N), N.sidecar, 'mined', { kind: 'N', vh: N.vh })
const seqOf = async (vh: Hex) => {
  const n = await readC<bigint>(C.board.address, X.boardAbi, 'count')
  for (let i = 0n; i < n; i++) if ((await readC<[Hex, bigint]>(C.board.address, X.boardAbi, 'posts', [i]))[0].toLowerCase() === vh.toLowerCase()) return i
  throw new Error(`no post of ${vh}`)
}
const seqS = await seqOf(S.vh)
const seqN = await seqOf(N.vh)
out.posts = { S: { seq: Number(seqS), block: postS?.block }, N: { seq: Number(seqN), block: postN?.block } }

// Three posts the Board must refuse. A fresh blob for the first, so only its header is wrong.
const S2 = blobOf(B.KIND.S, sEntries.slice(0, 10))
const wrongHeader = hexToBigInt(bytesToHex(B.headerOf(B.KIND.S, 9, P.S_BYTES)))
await postStep('refused: a header the blob does not open to', await post(S2, wrongHeader), S2.sidecar, 'refused', { claimedCount: 9, actualCount: 10 })
await postStep('refused: the same blob again', await post(S), S.sidecar, 'refused')
{
  const tx = await post(S2)
  await postStep('refused: no blob', { ...tx, blobVersionedHashes: [] }, undefined, 'refused')
}

// ---- arm 3: one entry proved in a posted blob ----

async function proveStep(step: string, p: Posted, seq: bigint, index: number, entry: Uint8Array, expect: 'mined' | 'reverts') {
  const { proof } = B.openElement(p.blob, 1 + index)
  const [k0, k1, k2] = X.kzgWords(p.commitment, proof)
  const args = [seq, BigInt(index), k0, k1, k2, bytesToHex(entry)] as const
  if (expect === 'reverts') {
    let answer = 'accepted'
    try {
      await chain.simulateContract({ address: C.board.address, abi: X.boardAbi, functionName: 'prove', args, account: funder })
    } catch (e) {
      answer = (e as Error).message.split('\n')[0].slice(0, 200)
    }
    if (answer === 'accepted') throw new Error(`${step}: a proof over a changed entry was accepted`)
    console.log(`${step}: reverts (${answer})`)
    rows.push({ step, expect, outcome: 'reverts', index, simulation: answer })
    return
  }
  const r = await eoaTx(step, await wallet.writeContract({ address: C.board.address, abi: X.boardAbi, functionName: 'prove', args } as never), { index, entryHash: keccak256(entry) })
  return r
}
await proveStep('inclusion: announcement 40 in the posted blob', S, seqS, 40, sEntries[40], 'mined')
await proveStep('inclusion: note 50 in the posted blob', N, seqN, 50, nEntries[50], 'mined')
{
  const changed = sEntries[40].slice()
  changed[600] ^= 1
  await proveStep('inclusion: announcement 40 with one byte changed', S, seqS, 40, changed, 'reverts')
}

// ---- arm 4: archivers challenged ----

async function challenge(step: string, who: 'A' | 'B', seq: bigint) {
  const r = await eoaTx(step, await wallet.writeContract({ address: C.archive.address, abi: X.archiveAbi, functionName: 'challenge', args: [archiver[who], seq], value: X.CHALLENGE_FEE } as never), { archiver: who, seq: Number(seq) })
  const receipt = await chain.getTransactionReceipt({ hash: r.hash as Hex })
  const ev = receipt.logs.map((l) => { try { return decodeEventLog({ abi: X.archiveAbi, ...l }) } catch { return undefined } }).find((e) => e?.eventName === 'Challenged')
  return { id: (ev!.args as unknown as { id: bigint }).id, block: BigInt(r.block as number) }
}
async function untilBlock(n: bigint) {
  await until(`block ${n}`, async () => ((await chain.getBlockNumber()) >= n ? true : undefined), 600_000, 3_000)
}
async function answerArgs(id: bigint, p: Posted, flip = false) {
  const z = await readC<bigint>(C.archive.address, X.archiveAbi, 'zOf', [id])
  const { proof, y } = B.openAt(p.blob, z)
  if (flip) y[31] ^= 1
  return { z, y, args: [id, bytesToHex(y), bytesToHex(new Uint8Array([...p.commitment, ...proof]))] as const }
}

// A answers a challenge over the announcements' blob from its own copy.
const cA = await challenge('archive: archiver A challenged over the announcements\' blob', 'A', seqS)
await untilBlock(cA.block + 1n)
{
  const { z, y, args } = await answerArgs(cA.id, S)
  await eoaTx('archive: A answers at the point its challenge drew', await walletOf(archiverKey.A).writeContract({ address: C.archive.address, abi: X.archiveAbi, functionName: 'answer', args } as never), { id: Number(cA.id), z: `0x${z.toString(16)}`, y: bytesToHex(y) })
  fixtures.answerA = { id: Number(cA.id), seq: Number(seqS), z: `0x${z.toString(16)}`, y: bytesToHex(y), kzg: args[2] }
}

// A wrong answer reverts; then the right one closes the challenge.
const cA2 = await challenge('archive: archiver A challenged over the notes\' blob', 'A', seqN)
await untilBlock(cA2.block + 1n)
{
  const wrong = await answerArgs(cA2.id, N, true)
  let answer = 'accepted'
  try {
    await chain.simulateContract({ address: C.archive.address, abi: X.archiveAbi, functionName: 'answer', args: wrong.args, account: archiver.A } as never)
  } catch (e) {
    answer = (e as Error).message.split('\n')[0].slice(0, 200)
  }
  if (answer === 'accepted') throw new Error('a wrong answer was accepted')
  console.log(`archive: a wrong y reverts (${answer})`)
  rows.push({ step: 'archive: A answers with a wrong y', expect: 'reverts', outcome: 'reverts', id: Number(cA2.id), simulation: answer })
  const right = await answerArgs(cA2.id, N)
  await eoaTx('archive: A answers the notes\' challenge correctly', await walletOf(archiverKey.A).writeContract({ address: C.archive.address, abi: X.archiveAbi, functionName: 'answer', args: right.args } as never), { id: Number(cA2.id) })
}

// B holds no copy: it is challenged, cannot answer, and is slashed after the window.
const bondB = await readC<bigint>(C.archive.address, X.archiveAbi, 'bondOf', [archiver.B])
const cB = await challenge('archive: archiver B, which holds nothing, challenged', 'B', seqS)
rows.push({ step: 'archive: B does not answer', outcome: 'no answer', id: Number(cB.id), note: 'B was never given a copy of the blob, so it has nothing to open at the drawn point' })
await untilBlock(cB.block + X.WINDOW + 1n)
await eoaTx('archive: B slashed after the window', await wallet.writeContract({ address: C.archive.address, abi: X.archiveAbi, functionName: 'slash', args: [cB.id] } as never), { id: Number(cB.id) })
const bondBAfter = await readC<bigint>(C.archive.address, X.archiveAbi, 'bondOf', [archiver.B])
if (bondB - bondBAfter !== X.BOND) throw new Error(`B's bond went from ${bondB} to ${bondBAfter}`)
out.archive = { bondBBefore: bondB.toString(), bondBAfter: bondBAfter.toString(), window: Number(X.WINDOW) }

// ---- the record ----

const record = {
  experiment: 17, run: runLabel, deployment: X.DEPLOYMENT, repoCommit, chainId: Number(chainId), funder,
  contracts: { announcer: C.announcer.address, board: C.board.address, archive: C.archive.address, packer: C.packer },
  archivers: archiver, pins, setup, rows, ...out,
}
const fixture = {
  chainId: Number(chainId), board: C.board.address, packer: C.packer, archive: C.archive.address,
  S: { vh: S.vh, header: `0x${S.header.toString(16)}`, entries: sEntries.map((e) => bytesToHex(e)), seq: Number(seqS) },
  N: { vh: N.vh, header: `0x${N.header.toString(16)}`, entries: nEntries.map((e) => bytesToHex(e)), seq: Number(seqN) },
  transactions: minedFrameTxs, ...fixtures,
}
for (const [name, body] of [['record', JSON.stringify(record)], ['fixture', JSON.stringify(fixture)]] as const) {
  for (const s of secretStrings) {
    const bare = s.replace(/^0x/, '').toLowerCase()
    if (bare.length >= 32 && body.toLowerCase().includes(bare)) throw new Error(`the ${name} contains a secret; not written`)
  }
}
writeFileSync(join(here, 'results', `${runLabel}.json`), JSON.stringify(record, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n')
writeFileSync(join(root, 'test/fixtures/x12', `${runLabel}.json`), JSON.stringify(fixture, null, 1) + '\n')
console.log(`recorded results/${runLabel}.json and test/fixtures/x12/${runLabel}.json`)
