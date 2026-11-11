// Experiment 17 (X12), arm 5: scanning, offline, after a run.
//   1. The run's two posted blobs are rebuilt from the fixture's entries, checked against the
//      versioned hashes the Board recorded on chain, and scanned with our recipient's keys.
//   2. Throughput: 10,000 entries of each kind, 40 of them ours, scanned on one core with this
//      repository's JavaScript (@noble/post-quantum, @noble/curves); every one of ours found and
//      nothing else.
//   3. Griefing: what a poster pays for one fake entry, as a log and in a blob, at the run's
//      recorded prices, against what one entry costs a scanner.
//
// usage: X12_DEPLOYMENT=<tag> npx tsx experiments/17-x12-ciphertexts-in-blobs/scan.ts <n>-<label>
import { readFileSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1'
import { type Hex, hexToBytes } from 'viem'
import { loadKey, run } from '../../src/e2e/index.js'
import { makeClient } from '../../src/exp-frames/frametx/index.js'
import * as B from './blob.js'
import * as P from './payloads.js'
import * as X from './x12.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const runLabel = process.argv[2]
if (!runLabel) throw new Error('usage: scan.ts <n>-<label>')
const record = JSON.parse(readFileSync(join(here, 'results', `${runLabel}.json`), 'utf8'))
const fixture = JSON.parse(readFileSync(join(root, 'test/fixtures/x12', `${runLabel}.json`), 'utf8'))
const { privateKey } = loadKey()
const me = P.keygen(X.seedOf(privateKey, 'recipient/s', 128))
const meN = P.noteKeygen(X.seedOf(privateKey, 'recipient/n', 64))
const chain = makeClient()
const out: Record<string, unknown> = { repoCommit: (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim(), cpu: cpus()[0]?.model, node: process.version }

// ---- 1. the posted blobs ----

for (const kind of ['S', 'N'] as const) {
  const f = fixture[kind]
  const entries = (f.entries as Hex[]).map((e) => hexToBytes(e))
  const blob = B.packBlob(kind === 'S' ? B.KIND.S : B.KIND.N, entries)
  const vh = B.versionedHashOf(B.commitmentOf(blob))
  const [onChain] = (await chain.readContract({ address: fixture.board, abi: X.boardAbi, functionName: 'posts', args: [BigInt(f.seq)] })) as [Hex, bigint]
  if (vh.toLowerCase() !== onChain.toLowerCase()) throw new Error(`${kind}: the rebuilt blob is ${vh}, the board recorded ${onChain}`)
  const found = entries.flatMap((e, i) => ((kind === 'S' ? P.scanS(me.tracking, e) : P.scanN(meN.dk, e)) ? [i] : []))
  console.log(`posted ${kind}: rebuilt to ${vh}, as recorded at seq ${f.seq}; ours at ${found.join(', ')}`)
  out[`posted${kind}`] = { vh, seq: f.seq, entries: entries.length, found, from: 'the run\'s fixture, checked against the versioned hash on chain; the test network served no blob data through any API found' }
}

// ---- 2. throughput ----

const TOTAL = 10_000
const OURS = 40
const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n))
const others = Array.from({ length: 50 }, () => { for (;;) { try { return P.keygen(rnd(128)).recipient } catch { /* again */ } } })
const ourAt = new Set(Array.from({ length: OURS }, (_, k) => Math.floor(((k + 0.5) * TOTAL) / OURS)))

function bench(kind: 'S' | 'N') {
  const t0 = performance.now()
  const entries = Array.from({ length: TOTAL }, (_, i) => kind === 'S'
    ? P.encodeS(P.announce(ourAt.has(i) ? me.recipient : others[i % others.length], secp256k1.utils.randomPrivateKey(), rnd(32)))
    : P.sealNote(ourAt.has(i) ? meN.ek : P.noteKeygen(rnd(64)).ek, rnd(64), rnd(32)))
  const makeMs = performance.now() - t0
  const t1 = performance.now()
  const found: number[] = []
  for (let i = 0; i < entries.length; i++) {
    if ((kind === 'S' ? P.scanS(me.tracking, entries[i]) : P.scanN(meN.dk, entries[i])) !== undefined) found.push(i)
  }
  const scanMs = performance.now() - t1
  const missed = [...ourAt].filter((i) => !found.includes(i))
  const extra = found.filter((i) => !ourAt.has(i))
  const r = { entries: TOTAL, ours: OURS, found: found.length, missed: missed.length, falseMatches: extra.length, makeMsPerEntry: +(makeMs / TOTAL).toFixed(4), scanMsPerEntry: +(scanMs / TOTAL).toFixed(4), scannedPerSecond: Math.round((TOTAL * 1000) / scanMs) }
  console.log(`${kind}: ${JSON.stringify(r)}`)
  return r
}
out.throughput = { S: bench('S'), N: bench('N') }

// ---- 3. griefing ----

const rowOf = (step: string) => record.rows.find((r: { step: string }) => r.step.startsWith(step))
const logS = record.rows.filter((r: { step: string }) => r.step.startsWith('log: one ERC-8441')).map((r: { gasUsed: number }) => r.gasUsed)
const logN = rowOf('log: one encrypted note').gasUsed
const carrierS = rowOf('blob: 107 announcements')
const carrierN = rowOf('blob: 105 encrypted notes')
const per = (kind: 'S' | 'N', prices: { baseFeePerGas: string; blobBaseFee: string }) => {
  const base = BigInt(prices.baseFeePerGas)
  const blobFee = BigInt(prices.blobBaseFee)
  const log = BigInt(kind === 'S' ? Math.round(logS.reduce((a: number, b: number) => a + b, 0) / logS.length) : logN) * base
  const c = kind === 'S' ? carrierS : carrierN
  const n = BigInt(c.entries)
  const blob = (BigInt(c.gasUsed) * base + BigInt(B.BLOB_GAS) * blobFee) / n
  const scanMs = (out.throughput as Record<string, { scanMsPerEntry: number }>)[kind].scanMsPerEntry
  return { logWei: log.toString(), blobWei: blob.toString(), logOverBlob: blob > 0n ? Number(log) / Number(blob) : null, scanMsPerEntry: scanMs, logWeiPerScanMs: Number(log) / scanMs, blobWeiPerScanMs: Number(blob) / scanMs }
}
out.griefing = Object.fromEntries((['testnet', 'mainnet'] as const).map((net) => [net, { prices: record.prices[net], S: per('S', record.prices[net]), N: per('N', record.prices[net]) }]))
console.log(JSON.stringify(out.griefing, null, 1))

const file = join(here, 'results', `${runLabel}-scan.json`)
writeFileSync(file, JSON.stringify(out, null, 2) + '\n')
console.log(file)
