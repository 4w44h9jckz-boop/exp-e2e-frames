// Experiment 18 (X13), prediction 6: what trial-decrypting one first-contact entry costs, on one
// core in JavaScript. The run's own figure for arm 2 timed the pool's fetch through the transport
// stand-in as well, so it includes a random delay and is not this measure.
//   1. The run's two blobs, rebuilt from the fixture and checked against their versioned hashes,
//      scanned with the recipient's key.
//   2. 10,000 entries, 40 of them to the recipient, scanned and timed.
//
// usage: X13_DEPLOYMENT=<tag> npx tsx experiments/18-x13-out-of-band-delivery/scan.ts <n>-<label>
import { readFileSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { type Hex, hexToBytes } from 'viem'
import { loadKey } from '../../src/e2e/index.js'
import * as B from '../17-x12-ciphertexts-in-blobs/blob.js'
import * as N from './notes.js'
import * as X from './x13.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const runLabel = process.argv[2]
if (!runLabel) throw new Error('usage: scan.ts <n>-<label>')
const fixture = JSON.parse(readFileSync(join(root, 'test/fixtures/x13', `${runLabel}.json`), 'utf8'))
const { privateKey } = loadKey()
const kem = N.kemKeygen(X.bytesOf(privateKey, 'recipient/kem', 64))
const out: Record<string, unknown> = { cpu: cpus()[0]?.model, node: process.version }

for (const k of ['arm3', 'arm6'] as const) {
  const entries = (fixture.blobs[k].entries as Hex[]).map((e) => hexToBytes(e))
  const vh = B.versionedHashOf(B.commitmentOf(B.packBlob(B.KIND.N, entries)))
  if (vh !== fixture.blobs[k].vh) throw new Error(`${k}: the rebuilt blob is ${vh}`)
  out[k] = { entries: entries.length, found: entries.flatMap((e, i) => (N.openFirst(kem.dk, e) ? [i] : [])) }
}

const TOTAL = 10_000
const OURS = 40
const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n))
const ourAt = new Set(Array.from({ length: OURS }, (_, k) => Math.floor(((k + 0.5) * TOTAL) / OURS)))
const others = Array.from({ length: 50 }, () => N.kemKeygen(rnd(64)).ek)
const o: N.Opening = { value: N.DENOM, n: 1n, s: 2n, T: 3n, refund: 4n }
const entries = Array.from({ length: TOTAL }, (_, i) => N.sealFirst(ourAt.has(i) ? kem.ek : others[i % 50], o, rnd(32)).entry)
const t0 = performance.now()
const found: number[] = []
for (let i = 0; i < TOTAL; i++) if (N.openFirst(kem.dk, entries[i])) found.push(i)
const ms = performance.now() - t0
out.throughput = { entries: TOTAL, ours: OURS, found: found.length, missed: [...ourAt].filter((i) => !found.includes(i)).length, falseMatches: found.filter((i) => !ourAt.has(i)).length, msPerEntry: +(ms / TOTAL).toFixed(4), perSecond: Math.round((TOTAL * 1000) / ms) }
console.log(JSON.stringify(out))
writeFileSync(join(here, 'results', `${runLabel}-scan.json`), JSON.stringify(out, null, 2) + '\n')
process.exit(0)
