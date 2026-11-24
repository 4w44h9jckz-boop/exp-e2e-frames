// Experiment 17 (X12), run 2, arm 4: one scanner that reads only the singleton's events.
//   1. Every Announcement with schemeId 3 over the run's blocks, read from the test network. A
//      direct one is trial-decrypted; a pointer (stealthAddress zero, a 63-byte key) is resolved
//      only if its caller is on the scanner's list of boards: the blob is rebuilt, its commitment's
//      versioned hash checked against the pointer and against the board's record, and its entries
//      scanned. A pointer from any other caller is counted and nothing is fetched for it.
//   2. The blob with one byte changed: rejected before any entry is scanned.
//   3. Run 1's scanner, which knows nothing of pointers, over every event.
//   4. Every entry's metadata read back from the rebuilt blob, against what was sent.
//   5. The predictions' figures from the run's record.
//
// usage: X12_DEPLOYMENT=<tag> npx tsx experiments/17-x12-ciphertexts-in-blobs/scan2.ts <n>-<label>
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Hex, decodeEventLog, hexToBytes, zeroAddress } from 'viem'
import { loadKey, run } from '../../src/e2e/index.js'
import { makeClient } from '../../src/exp-frames/frametx/index.js'
import * as B from './blob.js'
import * as P from './payloads.js'
import * as X from './x12.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const runLabel = process.argv[2]
if (!runLabel) throw new Error('usage: scan2.ts <n>-<label>')
const record = JSON.parse(readFileSync(join(here, 'results', `${runLabel}.json`), 'utf8'))
const fixture = JSON.parse(readFileSync(join(root, 'test/fixtures/x12', `${runLabel}.json`), 'utf8'))
const { privateKey } = loadKey()
const me = P.keygen(X.seedOf(privateKey, 'recipient/s', 128))
const chain = makeClient()
const out: Record<string, unknown> = { repoCommit: (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim() }

// The scanner's configuration: the boards it follows.
const BOARDS = new Set([String(fixture.board2).toLowerCase()])
// Where it fetches a pointed-to blob from. The test network serves no blob data through any API
// found in run 1, so the run's own copy stands in, and is checked before it is trusted.
const store = new Map<string, Uint8Array>([[String(fixture.blob.vh).toLowerCase(), B.packBlob(B.KIND.S2, (fixture.blob.entries as Hex[]).map((e) => hexToBytes(e)))]])

// ---- 1. the singleton's events ----

const logs = await chain.getLogs({ address: X.SINGLETON, fromBlock: BigInt(fixture.blocks.first), toBlock: BigInt(fixture.blocks.last) })
type Ev = { block: number; tx: Hex; schemeId: bigint; stealthAddress: Hex; caller: Hex; ephemeralPubKey: Hex; metadata: Hex }
const events: Ev[] = logs.map((l) => {
  const e = decodeEventLog({ abi: X.singletonAbi, data: l.data, topics: l.topics }) as unknown as { args: Omit<Ev, 'block' | 'tx'> }
  return { block: Number(l.blockNumber), tx: l.transactionHash as Hex, ...e.args }
})
const scheme3 = events.filter((e) => e.schemeId === 3n)
const isPointer = (e: Ev) => e.stealthAddress.toLowerCase() === zeroAddress && (e.ephemeralPubKey.length - 2) / 2 === 63

function resolve(e: Ev, blobs: Map<string, Uint8Array>) {
  const key = hexToBytes(e.ephemeralPubKey)
  const vh = `0x${Buffer.from(key.subarray(0, 32)).toString('hex')}`
  const headerTail = key.subarray(32)
  const blob = blobs.get(vh)
  if (!blob) return { outcome: 'no copy' as const }
  // The copy is trusted only if its commitment hashes to the pointer's versioned hash.
  if (B.versionedHashOf(B.commitmentOf(blob)).toLowerCase() !== vh) return { outcome: 'rejected: the copy does not match the versioned hash' as const, scanned: 0 }
  if (!Buffer.from(blob.subarray(1, 32)).equals(Buffer.from(headerTail))) return { outcome: 'rejected: the header does not match' as const, scanned: 0 }
  const { entries } = B.unpackBlob(blob)
  const found = entries.flatMap((x, i) => (P.scanS2(me.tracking, x) ? [i] : []))
  return { outcome: 'scanned' as const, vh, scanned: entries.length, found }
}

let fetched = 0
const ignored: Ev[] = []
const foundDirect: number[] = []
const foundInBlobs: Record<string, number[]> = {}
const others = { direct: 0, pointers: 0 }
const t0 = performance.now()
for (const e of scheme3) {
  if (isPointer(e)) {
    if (!BOARDS.has(e.caller.toLowerCase())) { ignored.push(e); continue }
    // The board's own record agrees with its pointer.
    const count = BigInt(`0x${e.metadata.slice(4)}`)
    const [recVh, recHeader] = (await chain.readContract({ address: e.caller, abi: X.boardAbi, functionName: 'posts', args: [count - 1n] })) as [Hex, bigint]
    const key = hexToBytes(e.ephemeralPubKey)
    if (recVh.toLowerCase() !== `0x${Buffer.from(key.subarray(0, 32)).toString('hex')}`) throw new Error('the board\'s record and its pointer disagree')
    if ((recHeader & ((1n << 248n) - 1n)) !== BigInt(`0x${Buffer.from(key.subarray(32)).toString('hex')}`)) throw new Error('the board\'s header and its pointer disagree')
    fetched++
    const r = resolve(e, store)
    if (r.outcome !== 'scanned') throw new Error(`the pointer from the board: ${r.outcome}`)
    foundInBlobs[r.vh] = r.found
    continue
  }
  const i = (fixture.direct as { ephemeralPubKey: Hex }[]).findIndex((d) => d.ephemeralPubKey.toLowerCase() === e.ephemeralPubKey.toLowerCase())
  if (i < 0) others.direct++
  const m = hexToBytes(e.metadata)
  if (m.length === 0) continue
  if (P.scanS(me.tracking, P.cat(hexToBytes(e.stealthAddress), hexToBytes(e.ephemeralPubKey), m.subarray(0, 1)))) foundDirect.push(i)
}
const scanMs = performance.now() - t0
const blobFound = Object.values(foundInBlobs).flat()
const truthDirect = (fixture.direct as { ours: boolean }[]).flatMap((d, i) => (d.ours ? [i] : []))
const falseDirect = foundDirect.filter((i) => !truthDirect.includes(i))
const falseBlob = blobFound.filter((i) => !(fixture.blob.ours as number[]).includes(i))
out.scanner = {
  events: events.length, scheme3: scheme3.length, pointersFromBoards: fetched, pointersIgnored: ignored.map((e) => ({ caller: e.caller, block: e.block, tx: e.tx })),
  blobsFetched: fetched, foundDirect, foundInBlobs, total: foundDirect.length + blobFound.length,
  missed: truthDirect.filter((i) => !foundDirect.includes(i)).length + (fixture.blob.ours as number[]).filter((i) => !blobFound.includes(i)).length,
  falseMatches: falseDirect.length + falseBlob.length, othersAnnouncementsInRange: others.direct, scanMs: Math.round(scanMs),
  blobsFrom: 'the run\'s own copy, checked against the versioned hash in the pointer and in the board\'s record',
}
console.log(`scanner: ${JSON.stringify(out.scanner)}`)

// ---- 2. a changed blob ----

{
  const changed = store.get(String(fixture.blob.vh).toLowerCase())!.slice()
  changed[32 * 200 + 5] ^= 1
  const ptr = scheme3.find((e) => isPointer(e) && BOARDS.has(e.caller.toLowerCase()))!
  const r = resolve(ptr, new Map([[String(fixture.blob.vh).toLowerCase(), changed]]))
  out.changedBlob = r
  console.log(`changed blob: ${r.outcome}`)
}

// ---- 3. run 1's scanner over every event ----

{
  let threw = 0
  const found: string[] = []
  for (const e of scheme3) {
    const m = hexToBytes(e.metadata)
    try {
      if (P.scanS(me.tracking, P.cat(hexToBytes(e.stealthAddress), hexToBytes(e.ephemeralPubKey), m.subarray(0, 1)))) found.push(e.tx)
    } catch {
      threw++
    }
  }
  const pointerMatches = scheme3.filter((e) => isPointer(e) && found.includes(e.tx)).length
  out.run1Scanner = { events: scheme3.length, found: found.length, threw, pointerMatches }
  console.log(`run 1's scanner: ${JSON.stringify(out.run1Scanner)}`)
}

// ---- 4. metadata read back ----

{
  const { entries } = B.unpackBlob(store.get(String(fixture.blob.vh).toLowerCase())!)
  const sent = (fixture.blob.entries as Hex[]).map((e) => P.decodeS2(hexToBytes(e))!.metadata)
  const differing = entries.filter((e, i) => !Buffer.from(P.decodeS2(e)!.metadata).equals(Buffer.from(sent[i]))).length
  out.metadata = { entries: entries.length, metadataBytes: P.META_BYTES, differing }
}

// ---- 5. the predictions' figures ----

const direct = record.rows.filter((r: { step: string }) => r.step.startsWith('direct:'))
const post = record.post
out.figures = {
  verifyExecution: post.verify.execution, verifyVsRun1: post.verify.execution - 59_387,
  senderExecution: post.sender.execution, senderOverRun1: post.sender.execution - 59_045, senderState: post.sender.state,
  directGas: [...new Set(direct.map((r: { gasUsed: number }) => r.gasUsed))], directCalldata: [...new Set(direct.map((r: { calldataBytes: number }) => r.calldataBytes))],
  capacity: B.capacity(P.S2_BYTES), blobGasPerEntry: +(B.BLOB_GAS / B.capacity(P.S2_BYTES)).toFixed(1),
}
const f = out.figures as Record<string, number | number[]>
const sc = out.scanner as Record<string, number>
const changed = out.changedBlob as { outcome: string; scanned?: number }
const r1 = out.run1Scanner as Record<string, number>
out.predictions = {
  1: Math.abs(f.verifyVsRun1 as number) <= 2_000 && (f.senderOverRun1 as number) >= 3_000 && (f.senderOverRun1 as number) <= 15_000 && f.senderState === 391_680,
  2: (f.directGas as number[]).length === 1 && (f.directGas as number[])[0] === 105_368,
  3: f.capacity === 102 && (out.metadata as { differing: number }).differing === 0,
  4: sc.total === 25 && sc.missed === 0 && sc.falseMatches === 0,
  5: (out.scanner as { pointersIgnored: unknown[] }).pointersIgnored.length >= 1 && sc.blobsFetched === 1 && changed.outcome.startsWith('rejected') && changed.scanned === 0,
  6: r1.threw === 0 && r1.pointerMatches === 0 && r1.found === 5,
}
console.log(`figures ${JSON.stringify(out.figures)}\npredictions ${JSON.stringify(out.predictions)}`)
const file = join(here, 'results', `${runLabel}-scan.json`)
writeFileSync(file, JSON.stringify(out, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n')
console.log(file)
