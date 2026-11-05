// Experiment 22 (Q1), arms 2, 3 and 5 on the local chain (README, Amendment 3): every transaction
// of shapes (a) to (c) in arm 1's inventory, rebuilt with a leanSPHINCS account as its sender, sent
// to skandha node A and then to the local ethrex's own pool; every block scanned for a classical
// signature; then three bad forms of one rebuilt transaction. No secp256k1 key is used: every
// account is funded at genesis, and the test network is only read.
//
// usage: npx tsx experiments/22-q1-leansphincs-senders/sweep.ts <n>-<label> [--limit N]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Address, type Hex, bytesToHex, concatHex, getAddress, getContractAddress, keccak256, pad } from 'viem'
import { type Node, type Pin, buildSkandha, checkout, linesNaming, peersOf, rpcUrlOf, run, startLocalChain, startNode, stopNode, until, writeConfig } from '../../src/e2e/index.js'
import { compileYul } from '../../src/exp-frames/contracts.js'
import { CREATE2_DEPLOYER } from '../../src/exp-frames/frametx/constants.js'
import { calldataCost } from '../../src/exp-frames/frametx/gas.js'
import { Approve, type Frame, type FrameTx, frameReceiptGas, frameReceiptStatus, frameSigHash, frameTxFromJson, frameTxHash, getNonceSeq, makeClient, serializeFrameTx, simulateFrameTx, verifyFrame } from '../../src/exp-frames/frametx/index.js'
import * as B from '../17-x12-ciphertexts-in-blobs/blob.js'
import * as L from '../19-x14-hash-based-stealth-addresses-under-8288/lean.js'
import * as X14 from '../19-x14-hash-based-stealth-addresses-under-8288/x14.js'
import { scanBlocks } from './scan.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const DIR = 'experiments/22-q1-leansphincs-senders'
const label = process.argv[2]
if (!label || !/^\d+-[a-z0-9-]+$/.test(label)) throw new Error('usage: sweep.ts <n>-<label> [--limit N]')
const limitArg = process.argv.indexOf('--limit')
const LIMIT = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity
mkdirSync(join(here, 'results'), { recursive: true })
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8')) as Record<string, Pin>
const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
const dirty = (await run('git', ['status', '--porcelain', '--', DIR, 'src'], { cwd: root })).trim()
if (dirty) throw new Error(`commit the experiment before a recorded run:\n${dirty}`)
const INVENTORY = '4-resolved'
const WAVE_TIMEOUT_MS = 180_000
const FUNDS = '0x21e19e0c9bab2400000' // 10,000 ETH
const ZERO32 = `0x${'00'.repeat(32)}` as Hex
const hexInt = (h: string | null | undefined) => (h ? Number(BigInt(h)) : 0)
const lower = (a: string) => a.toLowerCase()
// Protocol and precompile addresses: 18 leading zero bytes. Their code, if any, is genesis's own.
const isSystem = (a: string) => /^0x0{36}/i.test(a)

// ---- arm 1's keyed transactions, read back from the test network ----

const testnet = makeClient()
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const inventory = JSON.parse(readFileSync(join(here, 'results', `${INVENTORY}.json`), 'utf8')) as { transactions: Json[] }
const keyedInv = inventory.transactions.filter((t) => ['a', 'b', 'c'].includes(t.shape))
const rpcT = (method: string, params: unknown[]) => testnet.request({ method, params } as never) as Promise<Json>
const records: { inv: Json; tx: Json; receipt: Json }[] = []
for (let i = 0; i < keyedInv.length; i += 8) {
  const part = await Promise.all(keyedInv.slice(i, i + 8).map(async (inv) => ({ inv, tx: await rpcT('eth_getTransactionByHash', [inv.hash]), receipt: await rpcT('eth_getTransactionReceipt', [inv.hash]) })))
  records.push(...part)
}
records.sort((x, y) => hexInt(x.tx.blockNumber) - hexInt(y.tx.blockNumber) || hexInt(x.tx.transactionIndex) - hexInt(y.tx.transactionIndex))
const chosen = records.slice(0, LIMIT)
console.log(`${chosen.length} of ${records.length} keyed transactions`)

// ---- one leanSPHINCS account per sender, and the code the rebuilt frames call ----

const runtime = compileYul(`${DIR}/contracts/SphincsAccount.yul`)
const senderOf = (r: { tx: Json }) => getAddress(r.tx.type === '0x6' ? r.tx.sender : r.tx.from)
type Account = { old: Address; address: Address; key: Hex; seed: Uint8Array; impl: Address | null; implSource: string }
const accounts = new Map<string, Account>()
const secrets: string[] = []
const fixture = JSON.parse(readFileSync(join(root, 'work/ethrex/fixtures/genesis/l1-hegota.json'), 'utf8')) as { alloc: Record<string, unknown> }
const inGenesis = new Set(Object.keys(fixture.alloc).map(lower))
const alloc: Record<string, { balance: string; code?: Hex }> = {}
const codeOf = async (a: string) => (await testnet.getCode({ address: a as Address })) ?? '0x'
const copyCode = async (a: string): Promise<string | null> => {
  if (isSystem(a) || inGenesis.has(lower(a)) || alloc[lower(a)]) return null
  const code = await codeOf(a)
  if (code === '0x') return null
  alloc[lower(a)] = { balance: '0x0', code }
  if (code.startsWith('0xef0100')) await copyCode(`0x${code.slice(8, 48)}`)
  return code
}
for (const r of chosen) {
  const old = senderOf(r)
  if (accounts.has(lower(old))) continue
  const seed = crypto.getRandomValues(new Uint8Array(32))
  secrets.push(bytesToHex(seed))
  const key = bytesToHex(L.sphincsKey(seed)) as Hex
  const address = getAddress(`0x${keccak256(concatHex(['0x22', key])).slice(-40)}`)
  const oldCode = await codeOf(old)
  let impl: Address | null = null
  let implSource = 'none: a codeless sender'
  if (oldCode.startsWith('0xef0100')) {
    impl = getAddress(`0x${oldCode.slice(8, 48)}`)
    implSource = `EIP-7702 delegate ${impl}`
    await copyCode(impl)
  } else if (oldCode !== '0x') {
    impl = getAddress(`0x${keccak256(concatHex(['0x23', old])).slice(-40)}`)
    implSource = `the sender's own code, ${(oldCode.length - 2) / 2} bytes, copied to ${impl}`
    alloc[lower(impl)] = { balance: '0x0', code: oldCode }
  }
  alloc[lower(address)] = { balance: FUNDS, code: concatHex([runtime, pad(impl ?? '0x', { size: 32 }), key]) }
  accounts.set(lower(old), { old, address, key, seed, impl, implSource })
}
const subst = (data: Hex, a: Account): { data: Hex; count: number } => {
  const re = new RegExp(a.old.slice(2), 'gi')
  const count = (data.match(re) ?? []).length
  return { data: data.replace(re, a.address.slice(2).toLowerCase()) as Hex, count }
}

// ---- the rebuild (Amendment 3) ----

type Rebuilt = {
  i: number; r: { inv: Json; tx: Json; receipt: Json }; a: Account; shape: string
  frames: Frame[]; nonceKeys: bigint[]; fees: FrameTx['fees']; blobs: number
  copiedFrom: number[]; copiedTo: number[]; verifyIndex: number; depIndex: number
  changes: string[]; removed: { frame: number; mode: number; target: string | null; scope: number; why: string }[]
}
const rebuilt: Rebuilt[] = []
for (const [i, r] of chosen.entries()) {
  const a = accounts.get(lower(senderOf(r)))!
  const t = r.tx
  const changes: string[] = []
  const removed: Rebuilt['removed'] = []
  let subs = 0
  const keep = (f: Frame): Frame => {
    const target = f.target && lower(f.target) === lower(a.old) ? a.address : f.target
    if (target !== f.target) subs++
    const s = subst(f.data, a)
    subs += s.count
    return { ...f, target, data: s.data }
  }
  // A fresh nonce key's slot is paid in the sender's VERIFY (amendment 4): the rebuilt VERIFY takes
  // the state limit of the record's own.
  let verifyState = 0n
  if (t.type === '0x6') for (const f of frameTxFromJson(t as never).frames) if (f.mode === 1 && (f.flags & 3) !== 0 && (f.target === null || lower(f.target) === lower(t.sender))) verifyState = f.limits.state > verifyState ? f.limits.state : verifyState
  const verify = verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, execution: 30_000n, state: verifyState })
  const dep = X14.depFrame(X14.triple(X14.LEANSPHINCS_SCHEME, ZERO32, a.key))
  let frames: Frame[]
  let copiedFrom: number[]
  let nonceKeys = [0n]
  let fees: FrameTx['fees']
  let blobs = (t.blobVersionedHashes ?? []).length
  if (t.type === '0x6') {
    const tx = frameTxFromJson(t as never)
    if (lower(frameTxHash(tx)) !== lower(t.hash)) throw new Error(`${t.hash}: the frame transaction does not re-encode to its hash`)
    const last = Math.max(...tx.frames.map((f, k) => (f.mode === 1 && (f.flags & 3) !== 0 ? k : -1)))
    const prefix: Frame[] = []
    const prefixFrom: number[] = []
    tx.frames.slice(0, last + 1).forEach((f, k) => {
      const target = f.target ?? tx.sender
      if (f.mode === 1 && (f.flags & 3) !== 0) {
        removed.push({ frame: k, mode: 1, target: f.target, scope: f.flags & 3, why: lower(target) === lower(tx.sender) ? "the sender's own approval" : 'a payer other than the sender' })
        return
      }
      if (f.mode === 0 && f.target && lower(f.target) === lower(CREATE2_DEPLOYER) && f.data.length >= 66) {
        const made = getContractAddress({ opcode: 'CREATE2', from: CREATE2_DEPLOYER, salt: `0x${f.data.slice(2, 66)}` as Hex, bytecode: `0x${f.data.slice(66)}` as Hex })
        if (lower(made) === lower(tx.sender)) {
          removed.push({ frame: k, mode: 0, target: f.target, scope: 0, why: 'deploys the original sender' })
          return
        }
      }
      prefix.push(keep(f))
      prefixFrom.push(k)
    })
    const after = tx.frames.slice(last + 1).map(keep)
    frames = [...prefix, verify, dep, ...after]
    copiedFrom = [...prefixFrom, ...tx.frames.slice(last + 1).map((_, k) => last + 1 + k)]
    nonceKeys = tx.nonceKeys
    fees = tx.fees
    if (removed.some((x) => x.why === 'a payer other than the sender')) changes.push('payer: the account pays for itself')
  } else {
    const data = subst((t.input ?? '0x') as Hex, a)
    subs += data.count
    let target: Address | null = t.to ? getAddress(t.to) : null
    if (target && lower(target) === lower(a.old)) { target = a.address; subs++ }
    let frameData = data.data
    if (!target) {
      target = CREATE2_DEPLOYER
      frameData = concatHex([ZERO32, data.data])
      changes.push('creation: through the CREATE2 deployer, so the target and data change')
    }
    const gas = BigInt(t.gas)
    frames = [verify, dep, { mode: 2, flags: 0, target, limits: { execution: gas, state: gas }, value: BigInt(t.value), data: frameData }]
    copiedFrom = [0]
    fees = { maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas ?? t.gasPrice), maxFeePerGas: BigInt(t.maxFeePerGas ?? t.gasPrice), maxFeePerBlobGas: BigInt(t.maxFeePerBlobGas ?? 0) }
  }
  if (blobs) changes.push(`blobs: ${blobs} of fresh bytes, as the record keeps none`)
  if (subs) changes.push(`sender's address: ${subs} place(s) in the copied frames`)
  const verifyIndex = frames.indexOf(verify)
  const copiedTo = frames.map((_, k) => k).filter((k) => k !== verifyIndex && k !== verifyIndex + 1)
  rebuilt.push({ i, r, a, shape: r.inv.shape, frames, nonceKeys, fees, blobs, copiedFrom, copiedTo, verifyIndex, depIndex: verifyIndex + 1, changes, removed })
}
console.log(`rebuilt ${rebuilt.length} from ${accounts.size} senders; ${Object.keys(alloc).length - accounts.size} contracts copied`)
// Every contract a copied frame calls, its code from the test network.
for (const x of rebuilt) for (const k of x.copiedTo) { const tg = x.frames[k].target; if (tg) await copyCode(tg) }
console.log(`genesis: ${Object.keys(alloc).length} accounts`)

// ---- the chain and the two nodes ----

const chain = await startLocalChain({
  root, label: `q1-${label}`, setting: 'written', chainId: 8141, prover: L.PROVER,
  programs: join(root, 'experiments/19-x14-hash-based-stealth-addresses-under-8288/programs'), alloc,
})
const local = chain.client
console.log(`local chain ${chain.chainId}, ethrex ${chain.ethrexCommit.slice(0, 8)} (${chain.setting})`)
const skandha = await checkout('skandha', pins.skandha, join(root, 'work'))
await buildSkandha(skandha)
const stamp = Date.now()
const config = join(chain.dir, 'skandha.json')
writeConfig(config, chain.url)
const nodes: Node[] = []
const rows: Json[] = []
const bad: Json[] = []
let scan: Json = {}
let stalled: Json | null = null
const randomBlob = () => { const b = crypto.getRandomValues(new Uint8Array(B.BYTES_PER_BLOB)); for (let k = 0; k < b.length; k += 32) b[k] = 0; return b }
const sendRaw = async (url: string, raw: Hex) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }) })
  const body = (await res.json()) as { result?: string; error?: unknown }
  return body.error ? `refused: ${JSON.stringify(body.error).slice(0, 300)}` : `admitted: ${body.result}`
}
type Built = { tx: FrameTx; raw: Hex; hash: Hex; sighash: Hex; witness: string; signMs: number; sim: Json }
async function build(x: { a: Account; frames: Frame[]; nonceKeys: bigint[]; fees: FrameTx['fees']; blobs: number }, o: { sign?: Uint8Array; seedFor?: Uint8Array; message?: (h: Hex) => Hex } = {}): Promise<Built> {
  const nonceSeq = await getNonceSeq(local, x.a.address, x.nonceKeys)
  const sidecar = x.blobs ? B.sidecarOf(Array.from({ length: x.blobs }, randomBlob)) : null
  const tx: FrameTx = { chainId: chain.chainId, nonceKeys: x.nonceKeys, nonceSeq, sender: x.a.address, frames: x.frames, signatures: [], fees: x.fees, blobVersionedHashes: sidecar ? sidecar.commitments.map(B.versionedHashOf) : [] }
  const sighash = frameSigHash(tx)
  const seed = o.seedFor ?? x.a.seed
  const key = bytesToHex(o.seedFor ? L.sphincsKey(o.seedFor) : Buffer.from(x.a.key.slice(2), 'hex')) as Hex
  const msg = o.message ? o.message(sighash) : sighash
  const signed = L.sign(seed, Buffer.from(msg.slice(2), 'hex'))
  if (!signed.verified) throw new Error('the prover refuses its own signature')
  const witness = chain.putSphincsWitness(0x10, sighash, key, { publicKey: signed.publicKey, signature: signed.signature, message: signed.message })
  const sim = (await simulateFrameTx(local, tx).catch((e) => ({ error: String(e).slice(0, 300) }))) as Json
  const raw = sidecar ? B.frameTxWithBlobs(tx, sidecar) : serializeFrameTx(tx)
  return { tx, raw, hash: frameTxHash(tx), sighash, witness, signMs: signed.signMs, sim: { valid: sim.valid, violation: sim.violation, executionStatus: sim.executionStatus, gasUsed: sim.gasUsed, error: sim.error } }
}
async function submit(b: Built, a: Node): Promise<{ nodeA: string; direct: string | null }> {
  const nodeA = await sendRaw(rpcUrlOf(a), b.raw)
  let direct: string | null = null
  if (!nodeA.startsWith('admitted')) direct = await sendRaw(chain.url, b.raw)
  return { nodeA, direct }
}
const receiptOf = (h: Hex) => local.request({ method: 'eth_getTransactionReceipt', params: [h] } as never) as Promise<Json | null>

// The record's side of prediction 5, and the arithmetic as written.
function scoreOf(x: Rebuilt, rc: Json | null): Json {
  const t = x.r.tx
  const recRc = x.r.receipt
  const recFrames = (recRc.frameReceipts ?? []).map((f: Json) => frameReceiptGas(f as never))
  const recCopied = x.copiedFrom.reduce((s, k) => s + Number(recFrames[k]?.execution ?? 0n) + Number(recFrames[k]?.state ?? 0n), 0)
  // A type-2 receipt does not split the call's gas from the base, so its key cost is the base and
  // its calldata, which the rebuilt frame carries too.
  const recKey = t.type === '0x6' ? hexInt(recRc.gasUsed) - recCopied : 21_000 + Number(calldataCost((t.input ?? '0x') as Hex))
  const depBytes = calldataCost(x.frames[x.depIndex].data)
  let classical = 0
  const terms: Json = { dependency: 3000, dependencyCalldata: Number(depBytes) }
  if (t.type !== '0x6') { classical = 21_000; terms.typeTwoBase = -21_000 } else {
    const sigs = (t.signatures ?? []) as Json[]
    const k1 = sigs.filter((s) => s.scheme === '0x1').length
    const p256 = sigs.filter((s) => s.scheme === '0x2').length
    classical += 2800 * k1 + 6700 * p256
    terms.signatureList = -(2800 * k1 + 6700 * p256)
    if (x.shape === 'c') {
      // Its execution only: the state gas in it is the nonce's, as in the new VERIFY (amendment 4).
      const own = x.removed.filter((m) => m.why === "the sender's own approval").reduce((s, m) => s + Number(recFrames[m.frame]?.execution ?? 0n), 0)
      classical += own
      terms.recordVerify = -own
    }
    // Not in the arithmetic as written: gas the rebuild removes besides the key.
    const payer = x.removed.filter((m) => m.why !== "the sender's own approval").reduce((s, m) => s + Number(recFrames[m.frame]?.execution ?? 0n) + Number(recFrames[m.frame]?.state ?? 0n), 0)
    if (payer) terms.notInArithmetic_removedPayerOrDeployFrames = -payer
    if (x.shape === 'b') terms.notInArithmetic_recordSenderVerify = -x.removed.filter((m) => m.why === "the sender's own approval").reduce((s, m) => s + Number(recFrames[m.frame]?.execution ?? 0n) + Number(recFrames[m.frame]?.state ?? 0n), 0)
  }
  if (!rc) return { recordGasUsed: hexInt(recRc.gasUsed), recordKeyCost: recKey, terms }
  const frs = (rc.frameReceipts ?? []).map((f: Json) => frameReceiptGas(f as never))
  // The new VERIFY's key check is its execution gas; its state gas is the nonce's, paid on both sides
  // and so in both key costs (amendment 4).
  const newVerify = Number(frs[x.verifyIndex]?.execution ?? 0n)
  terms.newVerifyState = Number(frs[x.verifyIndex]?.state ?? 0n)
  const copied = x.copiedTo.reduce((s, k) => s + Number(frs[k]?.execution ?? 0n) + Number(frs[k]?.state ?? 0n), 0)
  const key = hexInt(rc.gasUsed) - copied
  terms.newVerify = newVerify
  if (t.type !== '0x6') terms.notInArithmetic_frameTxIntrinsic = 12_000 + 475 * x.frames.length + (BigInt(t.value) > 0n ? 6000 : 0)
  const predicted = 3000 + Number(depBytes) + newVerify - classical
  const measured = key - recKey
  return { recordGasUsed: hexInt(recRc.gasUsed), gasUsed: hexInt(rc.gasUsed), recordKeyCost: recKey, keyCost: key, measured, predicted, off: measured - predicted, held: Math.abs(measured - predicted) <= 5000, terms }
}

try {
  const a = await startNode({ dir: skandha, name: 'A', config, dataDir: join(chain.dir, `a-${stamp}`), apiPort: 15337, wsPort: 15437, p2pPort: 15000, log: join(chain.dir, 'a.frames.jsonl'), out: join(chain.dir, 'a.out'), handoff: true })
  nodes.push(a)
  const b = await startNode({ dir: skandha, name: 'B', config, dataDir: join(chain.dir, `b-${stamp}`), apiPort: 15338, wsPort: 15438, p2pPort: 15001, log: join(chain.dir, 'b.frames.jsonl'), out: join(chain.dir, 'b.out'), bootEnr: a.enr, handoff: true })
  nodes.push(b)
  await until('nodes A and B to peer', async () => {
    const [pa, pb] = await Promise.all([peersOf(a), peersOf(b)])
    return pa.includes(b.peerId) && pb.includes(a.peerId) ? true : undefined
  }, 120_000)

  // ---- arm 2: the waves ----

  const bySender = new Map<string, Rebuilt[]>()
  for (const x of rebuilt) bySender.set(lower(x.a.old), [...(bySender.get(lower(x.a.old)) ?? []), x])
  const waves = Math.max(...[...bySender.values()].map((v) => v.length))
  for (let w = 0; w < waves; w++) {
    const t0 = Date.now()
    const sent: { x: Rebuilt; b: Built; nodeA: string; direct: string | null }[] = []
    for (const list of bySender.values()) {
      const x = list[w]
      if (!x) continue
      const built = await build(x)
      sent.push({ x, b: built, ...(await submit(built, a)) })
    }
    // Only what a pool admitted can be mined; a refusal is final for this wave.
    const admitted = (s: { nodeA: string; direct: string | null }) => s.nodeA.startsWith('admitted') || String(s.direct).startsWith('admitted')
    const pending = new Map(sent.filter(admitted).map((s) => [s.b.hash, s]))
    const got = new Map<string, Json>()
    while (pending.size && Date.now() - t0 < WAVE_TIMEOUT_MS) {
      for (const h of [...pending.keys()]) { const rc = await receiptOf(h as Hex); if (rc) { got.set(h, rc); pending.delete(h) } }
      if (pending.size) await new Promise((r) => setTimeout(r, 1000))
    }
    for (const s of sent) {
      const rc = got.get(s.b.hash) ?? null
      const frames = rc ? (rc.frameReceipts as Json[]).map((f) => ({ status: frameReceiptStatus(f as never), execution: Number(frameReceiptGas(f as never).execution), state: Number(frameReceiptGas(f as never).state) })) : []
      const recFrames = (s.x.r.receipt.frameReceipts ?? []).map((f: Json) => ({ status: frameReceiptStatus(f as never), execution: Number(frameReceiptGas(f as never).execution), state: Number(frameReceiptGas(f as never).state) }))
      rows.push({
        index: s.x.i, wave: w, experiment: s.x.r.inv.experiment, shape: s.x.shape, record: s.x.r.tx.hash, recordType: s.x.r.tx.type, recordStatus: hexInt(s.x.r.receipt.status), recordFrames: recFrames,
        sender: { old: s.x.a.old, new: s.x.a.address }, hash: s.b.hash, bytes: (s.b.raw.length - 2) / 2,
        changes: s.x.changes, removed: s.x.removed, copied: s.x.copiedFrom.map((k, n) => [k, s.x.copiedTo[n]]),
        simulation: s.b.sim, nodeA: s.b ? s.nodeA : null, direct: s.direct,
        seen: { A: linesNaming(a.log, s.b.hash).length, B: linesNaming(b.log, s.b.hash).length },
        outcome: rc ? (frames.every((f) => f.status === 1) ? 'mined' : 'mined, a frame failed') : `not mined in ${WAVE_TIMEOUT_MS / 1000} s`,
        block: rc ? hexInt(rc.blockNumber) : null, frames, verifyGas: frames[s.x.verifyIndex]?.execution ?? null,
        signMs: Math.round(s.b.signMs), witness: s.b.witness, prediction5: scoreOf(s.x, rc),
      })
    }
    const minedNow = sent.filter((s) => got.has(s.b.hash)).length
    console.log(`wave ${w + 1}/${waves}: ${sent.length} sent, ${minedNow} mined, ${Math.round((Date.now() - t0) / 1000)} s`)
  }

  // ---- arm 5: every block, for a classical signature ----

  scan = await scanBlocks(local, chain.witnesses)
  console.log(`scan: ${scan.blocks} blocks, ${scan.classical.length} classical signatures`)

  // ---- arm 3: three bad forms of one rebuilt transaction ----

  const first = rows.find((r) => r.outcome === 'mined')
  if (first) {
    const x = rebuilt[first.index]
    const other = crypto.getRandomValues(new Uint8Array(32))
    secrets.push(bytesToHex(other))
    const otherKey = bytesToHex(L.sphincsKey(other)) as Hex
    const forms: { form: string; frames: Frame[]; o: Parameters<typeof build>[1] }[] = [
      { form: 'a triple naming another key', frames: x.frames.map((f, k) => (k === x.depIndex ? X14.depFrame(X14.triple(X14.LEANSPHINCS_SCHEME, ZERO32, otherKey)) : f)), o: { seedFor: other } },
      { form: 'no dependency frame', frames: x.frames.filter((_, k) => k !== x.depIndex), o: {} },
      { form: "a signature over another transaction's hash", frames: x.frames, o: { message: (h) => keccak256(concatHex([h, '0x01'])) } },
    ]
    for (const f of forms) {
      const t0 = Date.now()
      const built = await build({ ...x, frames: f.frames }, f.o)
      const sub = await submit(built, a)
      let rc: Json | null = null
      while (!rc && Date.now() - t0 < 120_000) { rc = await receiptOf(built.hash); if (!rc) await new Promise((r) => setTimeout(r, 2000)) }
      const head = Number(await local.getBlockNumber())
      bad.push({ form: f.form, hash: built.hash, simulation: built.sim, nodeA: sub.nodeA, direct: sub.direct, mined: !!rc, block: rc ? hexInt(rc.blockNumber) : null, headAfter: head })
      console.log(`bad form, ${f.form}: ${rc ? 'MINED' : 'not mined'}; simulation ${JSON.stringify(built.sim)}; pool ${sub.direct}`)
    }
    // Whether the chain still moves after the last form.
    const h0 = Number(await local.getBlockNumber())
    await new Promise((r) => setTimeout(r, 30_000))
    const h1 = Number(await local.getBlockNumber())
    stalled = { headBefore: h0, headAfter30s: h1, moving: h1 > h0 }
    console.log(`after the bad forms: head ${h0} then ${h1} 30 s later`)
  }
} finally {
  for (const n of nodes) await stopNode(n.child)
}
const builds = chain.builds()
const checks = chain.checks()
await chain.stop()

// ---- the record ----

const mined = rows.filter((r) => r.block !== null)
const p5 = mined.filter((r) => r.prediction5.held !== undefined)
const record = {
  experiment: 22, arms: [2, 3, 5], run: label, date: new Date().toISOString(), repoCommit, pins, inventory: `results/${INVENTORY}.json`,
  command: `npx tsx ${DIR}/sweep.ts ${label}${LIMIT < Infinity ? ` --limit ${LIMIT}` : ''}`,
  chain: { chainId: Number(chain.chainId), ethrex: chain.ethrexCommit, patch: 'experiments/19-x14-hash-based-stealth-addresses-under-8288/ethrex-8288.patch', setting: chain.setting, producerIntervalMs: 1000 },
  accounts: [...accounts.values()].map((x) => ({ old: x.old, new: x.address, key: x.key, implementation: x.impl, implementationSource: x.implSource })),
  copiedContracts: Object.keys(alloc).filter((k) => !accounts.has(k) && ![...accounts.values()].some((x) => lower(x.address) === k)),
  summary: {
    rebuilt: rows.length, admittedAtNodeA: rows.filter((r) => String(r.nodeA).startsWith('admitted')).length,
    admittedByPool: rows.filter((r) => r.direct === 'admitted' || String(r.direct).startsWith('admitted')).length,
    mined: mined.length, minedAllFramesOk: rows.filter((r) => r.outcome === 'mined').length,
    prediction5: { scored: p5.length, held: p5.filter((r) => r.prediction5.held).length },
    byShape: Object.fromEntries(['a', 'b', 'c'].map((s) => [s, { rebuilt: rows.filter((r) => r.shape === s).length, mined: mined.filter((r) => r.shape === s).length }])),
  },
  rows, bad, stalled, scan, builds, checks,
}
let text = JSON.stringify(record, null, 2)
for (const s of secrets) if (text.toLowerCase().includes(s.slice(2).toLowerCase())) throw new Error('a secret would be recorded')
text += '\n'
writeFileSync(join(here, 'results', `${label}.json`), text)
console.log(`recorded results/${label}.json: ${JSON.stringify(record.summary)}`)
process.exit(0)
