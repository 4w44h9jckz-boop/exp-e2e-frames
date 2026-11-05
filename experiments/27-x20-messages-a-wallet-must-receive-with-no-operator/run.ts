// Experiment 27 (X20): arms 1 to 6 on the local chain (README, amendment 1).
//
// usage: npx tsx experiments/27-x20-messages-a-wallet-must-receive-with-no-operator/run.ts <n>-<label>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Address, type Hex, bytesToHex, hexToBytes, keccak256 } from 'viem'
import { run, startLocalChain } from '../../src/e2e/index.js'
import { compileYul } from '../../src/exp-frames/contracts.js'
import { type FrameTx, frameReceiptGas, frameReceiptStatus, frameTxHash, getFrameTxJson, serializeFrameTx, simulateFrameTx, waitForFrameTxReceipt } from '../../src/exp-frames/frametx/index.js'
import * as B from '../17-x12-ciphertexts-in-blobs/blob.js'
import * as L from '../19-x14-hash-based-stealth-addresses-under-8288/lean.js'
import { scanBlocks } from '../22-q1-leansphincs-senders/scan.js'
import * as X from './x20.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const DIR = 'experiments/27-x20-messages-a-wallet-must-receive-with-no-operator'
const label = process.argv[2]
if (!label || !/^\d+-[a-z0-9-]+$/.test(label)) throw new Error('usage: run.ts <n>-<label>')
delete process.env.PRIVATE_KEY
const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
const dirty = (await run('git', ['status', '--porcelain', '--', DIR, 'src'], { cwd: root })).trim()
if (dirty) throw new Error(`commit the experiment before a recorded run:\n${dirty}`)

// ---- the board's runtime code, from its "runtime" object alone ----
function runtime(): Hex {
  const src = readFileSync(join(here, 'contracts/Board.yul'), 'utf8')
  const start = src.indexOf('object "runtime" {')
  let depth = 0
  let end = -1
  for (let i = start; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } } }
  const file = join(root, 'work', 'x20-board-runtime.yul')
  writeFileSync(file, src.slice(start, end))
  return compileYul(file)
}

// ---- the parties: three leanSPHINCS keys, each with a deposit; relays and archivers by address ----
type Party = { name: string; seed: Uint8Array; key: Hex; version: number }
const party = (name: string): Party => { const seed = crypto.getRandomValues(new Uint8Array(32)); return { name, seed, key: bytesToHex(L.sphincsKey(seed)) as Hex, version: 0 } }
const W1 = party('W1'); const W2 = party('W2'); const G = party('G')
const parties = [W1, W2, G]
const R1 = '0x00000000000000000000000000000000000020a1' as Address
const R2 = '0x00000000000000000000000000000000000020a2' as Address
const A1 = '0x00000000000000000000000000000000000020b1' as Address
const A2 = '0x00000000000000000000000000000000000020b2' as Address
const DEPOSIT = 10n ** 18n
const storage: Record<string, Hex> = {}
for (const p of parties) storage[X.mapslot(p.key, 3)] = X.word(DEPOSIT)
const chain = await startLocalChain({
  root, label: `x20-${label}`, setting: 'written', chainId: 8141, prover: L.PROVER,
  programs: join(root, 'experiments/19-x14-hash-based-stealth-addresses-under-8288/programs'),
  alloc: { [X.BOARD]: { balance: `0x${(4n * DEPOSIT).toString(16)}`, code: runtime(), storage } },
})
const client = chain.client
console.log(`local chain ${chain.chainId}, ethrex ${chain.ethrexCommit.slice(0, 8)} (${chain.setting})`)

type Json = Record<string, unknown>
const rows: Json[] = []
async function send(step: string, t: FrameTx, expect: 'mined' | 'refused', raw?: Hex, extra: Json = {}) {
  const sim = await simulateFrameTx(client, t).catch((e) => ({ valid: false, violation: (e as Error).message.slice(0, 300), executionStatus: null }))
  const bytes = raw ?? serializeFrameTx(t)
  const hash = frameTxHash(t)
  const res = await fetch(chain.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [bytes] }) })
  const body = (await res.json()) as { result?: string; error?: { message?: string } }
  const pool = body.error ? `refused: ${(body.error.message ?? JSON.stringify(body.error)).slice(0, 300)}` : `admitted: ${body.result}`
  const r = body.error ? undefined : await waitForFrameTxReceipt(client, hash, { timeoutMs: 120_000 }).catch(() => undefined)
  const frames = r ? r.frameReceipts.map((f) => ({ status: frameReceiptStatus(f), ...frameReceiptGas(f) })) : []
  const row = {
    step, expect, hash, outcome: r ? (frames.every((f) => f.status === 1) ? 'mined' : 'mined, a frame failed') : 'not mined',
    block: r ? Number(BigInt(r.blockNumber)) : null, gasUsed: r ? Number(BigInt(r.gasUsed)) : null,
    frames: frames.map((f) => ({ status: f.status, execution: Number(f.execution), state: Number(f.state) })),
    pool, simulation: { valid: sim.valid, violation: sim.violation }, signatures: t.signatures.length, ...extra,
  }
  rows.push(row)
  console.log(`${step}: ${row.outcome}${r ? ` block ${row.block} gas ${row.gasUsed}` : ` (${pool.slice(0, 110)})`}`)
  if (expect === 'mined' && row.outcome !== 'mined') throw new Error(`${step}: expected mined, got ${row.outcome}: ${pool} ${JSON.stringify(row.simulation)}`)
  return row
}
const sign = (p: Party, m: Hex) => { chain.putSphincsWitness(0x10, m, p.key, L.sign(p.seed, hexToBytes(m))) }

// What each carrier received, for arm 5.
const relayInputs: Record<string, Json[]> = { R1: [], R2: [] }
const archiverInputs: Record<string, Json[]> = { A1: [], A2: [] }
const archiveStore: Record<string, Map<Hex, Uint8Array>> = { A1: new Map(), A2: new Map() }
const archiverOnline: Record<string, boolean> = { A1: true, A2: true }
const plaintexts: string[] = []

// ---- arm 1: the directory ----
const kem = new Map<string, ReturnType<typeof X.kemKeys>>()
async function setKey(p: Party, step: string) {
  const k = X.kemKeys(p.seed, p.version)
  sign(p, X.dirMessage(p.key, k.publicKey, p.version))
  await send(step, X.setKeyTx(chain.chainId, p.key, p.version, k.publicKey), 'mined', undefined, { kind: 'setKey', party: p.name, version: p.version })
  kem.set(p.name, k)
  p.version++
}
/** Any reader's view of the directory: the latest key each party's KeySet logs name. */
type Log = { topics: Hex[]; data: Hex; transactionHash: Hex; blockNumber: Hex }
const rpc = async <T>(method: string, params: unknown[]): Promise<T> => ((await (await fetch(chain.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as { result: T }).result
const logsOf = (topic: Hex) => rpc<Log[]>('eth_getLogs', [{ address: X.BOARD, fromBlock: '0x0', toBlock: 'latest', topics: [topic] }])
async function directoryKey(key: Hex): Promise<Uint8Array> {
  const ls = (await logsOf(X.TOPIC.KeySet as Hex)).filter((l) => l.topics[1].toLowerCase() === key.toLowerCase())
  const last = ls[ls.length - 1]
  return hexToBytes(`0x${last.data.slice(2 + 192, 2 + 192 + 2 * 1184)}` as Hex)
}

// ---- the pairs and the document, as each party keeps them ----
// The sender's side of each pair ("from>to"), and each recipient's, learned only by opening a first
// contact; each recipient's document keys, learned only from a grant.
const pairs = new Map<string, { ss: Hex; next: number }>()
const recvPairs = new Map<string, Hex>()
const knownDocKeys = new Map<string, Set<Hex>>(['W1', 'W2', 'G'].map((n) => [n, new Set<Hex>()]))
let docKey: Hex = X.word(0)
let docSeq = 0
const RELAY_FEE_PER_BYTE = 100_000n
const SELF_FEE = 3n * 10n ** 8n
const ARCHIVER_FEE = 10n ** 6n

/** A sender's envelope to a recipient: first contact through the directory, then the pair's tag. */
async function envelope(from: Party, to: Party, body: Json) {
  const plain = JSON.stringify({ from: from.name, ...body })
  plaintexts.push(plain)
  const id = `${from.name}>${to.name}`
  const p = pairs.get(id)
  if (!p) {
    const { env, ss } = X.sealFirst(await directoryKey(to.key), plain)
    pairs.set(id, { ss, next: 1 })
    return { env, kind: X.KIND.FIRST, tag: X.word(0) }
  }
  const i = p.next++
  return { env: X.sealPair(p.ss, i, plain), kind: X.KIND.PAIR, tag: X.pairTag(p.ss, i) }
}
function checkpoint(body: Json) {
  const plain = JSON.stringify({ doc: 'x20', ...body })
  plaintexts.push(plain)
  docSeq++
  return { env: X.sealDoc(docKey, docSeq, plain), kind: X.KIND.DOC, tag: X.docTag(docKey, docSeq) }
}

/** A relay posts its senders' envelopes in one blob, and hands the blob to every archiver it knows. */
async function relayPost(step: string, relay: 'R1' | 'R2', relayTo: Address, items: { from: Party; e: { env: Uint8Array; kind: number; tag: Hex } }[]) {
  const entries: X.Entry[] = items.map(({ from, e }) => ({ senderKey: from.key, env: e.env, kind: e.kind, tag: e.tag, fee: RELAY_FEE_PER_BYTE * BigInt(e.env.length) }))
  for (const [i, en] of entries.entries()) {
    relayInputs[relay].push({ senderKey: en.senderKey, envHash: keccak256(en.env), bytes: en.env.length, kind: en.kind, tag: en.tag, fee: en.fee.toString() })
    sign(items[i].from, X.postMessage(keccak256(en.env), en.fee, relayTo, 0))
  }
  const p = X.postTx(chain.chainId, entries, relayTo, 0)
  const row = await send(step, p.tx, 'mined', B.frameTxWithBlobs(p.tx, p.sidecar!), { kind: 'post', carrier: 'blob', relay, entries: entries.length, envelopeBytes: entries.reduce((a, e) => a + e.env.length, 0), fees: entries.map((e) => e.fee.toString()) })
  for (const a of ['A1', 'A2']) if (archiverOnline[a]) { archiveStore[a].set(p.versionedHash!, p.blob!); archiverInputs[a].push({ from: relay, versionedHash: p.versionedHash, bytes: p.blob!.length }) }
  return row
}
/** A sender with no relay posts its own envelope in calldata, paid from its own deposit. */
async function selfPost(step: string, from: Party, e: { env: Uint8Array; kind: number; tag: Hex }) {
  const entry: X.Entry = { senderKey: from.key, env: e.env, kind: e.kind, tag: e.tag, fee: SELF_FEE }
  sign(from, X.postMessage(keccak256(e.env), SELF_FEE, X.BOARD, 1))
  const p = X.postTx(chain.chainId, [entry], X.BOARD, 1)
  return send(step, p.tx, 'mined', undefined, { kind: 'post', carrier: 'calldata', relay: null, entries: 1, envelopeBytes: e.env.length, fees: [SELF_FEE.toString()] })
}

// ---- a recipient's scan: the board's logs, the archivers' blobs, and calldata ----
const opened: Json[] = []
let redeemNonce = 0
async function scan(me: Party, o: { secretKeys: Uint8Array[]; archivers: string[] }) {
  const docKeys = knownDocKeys.get(me.name)!
  const tagsOf = (ss: Hex) => Array.from({ length: 16 }, (_, i) => X.pairTag(ss, i))
  const anns = await logsOf(X.TOPIC.Announce as Hex)
  const fetched = new Map<Hex, Uint8Array>()
  const found: Json[] = []
  for (const a of anns) {
    const d = a.data.slice(2)
    const kind = Number(BigInt(`0x${d.slice(0, 64)}`))
    const tag = `0x${d.slice(64, 128)}` as Hex
    const vh = `0x${d.slice(128, 192)}` as Hex
    const offset = Number(BigInt(`0x${d.slice(192, 256)}`))
    const length = Number(BigInt(`0x${d.slice(256, 320)}`))
    const envHash = a.topics[1]
    // Is it mine? First contact: try every key. A pair's or a document's tag: compare.
    const pairHit = [...recvPairs.entries()].find(([id, ss]) => id.endsWith(`>${me.name}`) && tagsOf(ss).includes(tag))
    const docHit = [...docKeys].find((k) => Array.from({ length: 8 }, (_, s) => X.docTag(k, s)).includes(tag))
    if (kind === X.KIND.PAIR && !pairHit) continue
    if (kind === X.KIND.DOC && !docHit) continue
    // Read the envelope: from calldata if the post carried it, else the whole blob from an archiver.
    let env: Uint8Array | null = null
    let source = ''
    if (BigInt(vh) === 0n) {
      const j = await getFrameTxJson(client, a.transactionHash)
      const data = (j?.frames ?? [])[2]?.data as Hex
      const n = Number(BigInt(`0x${data.slice(2 + 2 * 0x44, 2 + 2 * 0x64)}`))
      const region = 0x64 + n * 224
      env = hexToBytes(`0x${data.slice(2 + 2 * (region + offset), 2 + 2 * (region + offset + length))}` as Hex)
      source = 'calldata'
    } else {
      let blob = fetched.get(vh) ?? null
      for (const ar of o.archivers) {
        if (blob) break
        archiverInputs[ar].push({ request: { versionedHash: vh }, by: me.name, online: archiverOnline[ar] })
        if (!archiverOnline[ar]) continue
        const b = archiveStore[ar].get(vh) ?? null
        if (b && B.versionedHashOf(B.commitmentOf(b)) === vh) {
          blob = b
          source = `blob from ${ar}`
          // The recipient pays the archiver by a voucher, which the archiver redeems.
          const arAddr = ar === 'A1' ? A1 : A2
          const nonce = redeemNonce++
          sign(me, X.redeemMessage(vh, arAddr, ARCHIVER_FEE, nonce))
          await send(`${ar} redeems ${me.name}'s voucher`, X.redeemTx(chain.chainId, me.key, arAddr, vh, ARCHIVER_FEE, nonce), 'mined', undefined, { kind: 'redeem', archiver: ar, by: me.name })
        }
      }
      if (!blob) { found.push({ envHash, kind, outcome: 'no archiver served the blob' }); continue }
      fetched.set(vh, blob)
      env = X.readBlob(blob, offset, length)
      source = source || 'blob, fetched before'
    }
    if (keccak256(env) !== envHash) { found.push({ envHash, kind, outcome: 'envelope does not match its hash' }); continue }
    let plain: string | null = null
    if (kind === X.KIND.FIRST) {
      for (const sk of o.secretKeys) {
        const r = X.openFirst(sk, env)
        if (r) {
          plain = r.plain
          const from = (JSON.parse(r.plain) as { from: string }).from
          if (!recvPairs.has(`${from}>${me.name}`)) recvPairs.set(`${from}>${me.name}`, r.ss)
          break
        }
      }
    } else if (kind === X.KIND.PAIR && pairHit) {
      plain = X.openPair(pairHit[1], tagsOf(pairHit[1]).indexOf(tag), env)
    } else if (kind === X.KIND.DOC && docHit) {
      const s = Array.from({ length: 8 }, (_, k) => X.docTag(docHit, k)).indexOf(tag)
      plain = X.openDoc(docHit, s, env)
    }
    if (plain !== null) {
      const body = JSON.parse(plain) as { grant?: { key: Hex } }
      if (body.grant) docKeys.add(body.grant.key)
      found.push({ envHash, kind, source, block: Number(BigInt(a.blockNumber)), plain: body })
    }
  }
  return found
}

let failure: string | null = null
const scans: Json = {}
const checks: Json = {}
try {
  // ---- arm 1 ----
  await setKey(W1, 'W1 writes its directory entry')
  await setKey(W2, 'W2 writes its directory entry')
  await setKey(G, 'G writes its directory entry')
  const badK = X.kemKeys(W2.seed, 99)
  sign(W2, X.dirMessage(W1.key, badK.publicKey, W1.version))
  await send('bad: W1\'s entry written under W2\'s signature', X.setKeyTx(chain.chainId, W1.key, W1.version, badK.publicKey, W2.key), 'refused', undefined, { kind: 'setKey' })
  // A message to W1's first key, then W1 rotates; the new key must not open it.
  const old = X.sealFirst(kem.get('W1')!.publicKey, JSON.stringify({ from: 'G', note: 'sealed to W1\'s first key' }))
  const w1Old = kem.get('W1')!
  await setKey(W1, 'W1 rotates its directory entry')
  checks.rotation = { newKeyOpensOldMessage: X.openFirst(kem.get('W1')!.secretKey, old.env) !== null, oldKeyOpensOldMessage: X.openFirst(w1Old.secretKey, old.env) !== null, directoryServesNewKey: bytesToHex(await directoryKey(W1.key)) === bytesToHex(kem.get('W1')!.publicKey) }

  // ---- arm 2: R1 refuses W2's payloads; R2 carries them; A1 is gone when the recipients fetch ----
  docKey = bytesToHex(crypto.getRandomValues(new Uint8Array(32))) as Hex
  const docKey1 = docKey
  const m1 = await envelope(W2, W1, { note: { value: '100000000000000000', blinding: bytesToHex(crypto.getRandomValues(new Uint8Array(32))), leaf: 7 } })
  const m2 = await envelope(G, W1, { share: bytesToHex(crypto.getRandomValues(new Uint8Array(32))), of: 'W1 recovery, 2 of 3' })
  const g1 = await envelope(W2, W1, { grant: { doc: 'x20', key: docKey1 } })
  const g2 = await envelope(W2, G, { grant: { doc: 'x20', key: docKey1 } })
  const c1 = checkpoint({ seq: 1, text: 'checkpoint one '.repeat(40) })
  relayInputs.R1.push({ refused: ['m1', 'g1', 'g2', 'c1'].map(() => 'W2') })
  await relayPost('R1 posts G\'s recovery share, refusing W2\'s payloads', 'R1', R1, [{ from: G, e: m2 }])
  await relayPost('R2 posts W2\'s note opening, two grants and a checkpoint', 'R2', R2, [{ from: W2, e: m1 }, { from: W2, e: g1 }, { from: W2, e: g2 }, { from: W2, e: c1 }])
  archiverOnline.A1 = false
  scans.arm2W1 = await scan(W1, { secretKeys: [kem.get('W1')!.secretKey], archivers: ['A1', 'A2'] })
  scans.arm2G = await scan(G, { secretKeys: [kem.get('G')!.secretKey], archivers: ['A1', 'A2'] })

  // ---- arm 3: no relay and no archiver: each sender posts its own envelope in calldata ----
  archiverOnline.A2 = false
  await selfPost('W2 posts its second note opening itself', W2, await envelope(W2, W1, { note: { value: '50000000000000000', blinding: bytesToHex(crypto.getRandomValues(new Uint8Array(32))), leaf: 8 } }))
  await selfPost('G posts its second share itself', G, await envelope(G, W1, { share: bytesToHex(crypto.getRandomValues(new Uint8Array(32))), of: 'W1 recovery, 2 of 3, rotated' }))
  await selfPost('W2 posts checkpoint 2 itself', W2, checkpoint({ seq: 2, text: 'checkpoint two '.repeat(40) }))
  scans.arm3W1 = await scan(W1, { secretKeys: [kem.get('W1')!.secretKey], archivers: [] })

  // ---- arm 4: W2 revokes G with a new document key, granted to W1 alone ----
  docKey = bytesToHex(crypto.getRandomValues(new Uint8Array(32))) as Hex
  const docKey2 = docKey
  docSeq = 0
  await selfPost('W2 grants the new document key to W1 alone', W2, await envelope(W2, W1, { grant: { doc: 'x20', key: docKey2 } }))
  await selfPost('W2 posts checkpoint 1 under the new key', W2, checkpoint({ seq: 3, text: 'after revocation '.repeat(40) }))
  scans.arm4W1 = await scan(W1, { secretKeys: [kem.get('W1')!.secretKey], archivers: [] })
  scans.arm4G = await scan(G, { secretKeys: [kem.get('G')!.secretKey], archivers: [] })
  checks.revocation = { docKey2, w1KnowsNewKey: knownDocKeys.get('W1')!.has(docKey2), gKnowsNewKey: knownDocKeys.get('G')!.has(docKey2) }
} catch (e) {
  failure = (e as Error).message.slice(0, 600)
  console.log(`stopped: ${failure}`)
} finally {
  await new Promise((r) => setTimeout(r, 15_000))
  const scanResult = await scanBlocks(client, chain.witnesses).catch((e) => ({ error: (e as Error).message.slice(0, 200) }))
  const builds = chain.builds()
  const chainChecks = chain.checks()
  await chain.stop()
  // Arm 5: what each carrier received, against the table.
  const recipientKeys = parties.flatMap((p) => [p.key.toLowerCase().slice(2), ...[...kem.entries()].filter(([n]) => n === p.name).map(([, k]) => bytesToHex(k.publicKey).slice(2, 66))])
  const carrierText = JSON.stringify({ relayInputs, archiverInputs }).toLowerCase()
  const leaks = {
    plaintextInCarrierInputs: plaintexts.filter((p) => carrierText.includes(p.toLowerCase().slice(0, 40))).length,
    recipientKeyInRelayInputs: ['W1', 'G'].filter((n) => JSON.stringify(relayInputs).toLowerCase().includes(parties.find((p) => p.name === n)!.key.toLowerCase().slice(2))).length,
    archiverRequestsNamingAPayload: Object.values(archiverInputs).flat().filter((r) => JSON.stringify(r).includes('envHash')).length,
  }
  const record = {
    experiment: 27, run: label, date: new Date().toISOString(), repoCommit, command: `npx tsx ${DIR}/run.ts ${label}`,
    chain: { chainId: Number(chain.chainId), ethrex: chain.ethrexCommit, setting: chain.setting },
    board: X.BOARD, fees: { relayPerByte: RELAY_FEE_PER_BYTE.toString(), selfPost: SELF_FEE.toString(), archiverPerRetrieval: ARCHIVER_FEE.toString() },
    sizes: { firstContact: X.FIRST_BYTES, tagged: X.TAGGED_BYTES, plaintext: X.PLAIN_BYTES },
    rows, checks, scans, relayInputs, archiverInputs: Object.fromEntries(Object.entries(archiverInputs).map(([k, v]) => [k, v])), leaks,
    scan: { blocks: (scanResult as { blocks?: number }).blocks ?? null, classical: (scanResult as { classical?: unknown[] }).classical ?? null },
    builds, chainChecks, failure,
  }
  const text = JSON.stringify(record, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
  for (const p of parties) if (text.includes(bytesToHex(p.seed).slice(2))) throw new Error('a seed would reach the record')
  mkdirSync(join(here, 'results'), { recursive: true })
  const out = join(here, 'results', `${label}.json`)
  writeFileSync(out, `${text}\n`)
  console.log(`recorded ${out}; ${rows.length} transactions; leaks ${JSON.stringify(leaks)}`)
}
process.exit(0)
