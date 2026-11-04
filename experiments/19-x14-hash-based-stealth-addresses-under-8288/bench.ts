// Experiment 19 (X14), run 1, offline, on an idle machine: prediction 7 (what a proof costs on a
// machine one can buy) and prediction 10 (scanning).
//   1. Versions 1 and 5 proved by prover/ with three measured passes after a warm-up each; the
//      leanSPHINCS signer of version 3, five times.
//   2. 10,000 announcements of schemeId 6 (an ML-KEM-768 ciphertext and a view tag, the account's
//      address beside it), 40 to our recipient, scanned: decapsulate, check the view tag, derive r,
//      rebuild C and the account's CREATE2 address, compare.
//
// usage: X14_DEPLOYMENT=<tag> npx tsx experiments/19-x14-hash-based-stealth-addresses-under-8288/bench.ts <n>-<label>
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'
import { join } from 'node:path'
import { sha256 } from '@noble/hashes/sha2'
import { keccak_256 } from '@noble/hashes/sha3'
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js'
import { bytesToHex } from 'viem'
import * as L from './lean.js'
import * as X from './x14.js'

const here = new URL('.', import.meta.url).pathname
const runLabel = process.argv[2]
if (!runLabel) throw new Error('usage: bench.ts <n>-<label>')
const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n))
const out: Record<string, unknown> = { cpu: cpus()[0]?.model, cores: cpus().length, memoryGiB: +(totalmem() / 2 ** 30).toFixed(1), node: process.version }

// ---- 1. proofs ----

const v1 = L.v1(rnd(32), rnd(32), rnd(32))
out.v1 = L.prove('v1_preimage', v1.input, 3)
const leaves: Uint8Array[] = Array.from({ length: 8 }, () => rnd(32))
const ns = rnd(32), s = rnd(32)
leaves[5] = L.leafOf(ns, s)
out.v5 = L.prove('v5_tornado', L.v5(ns, s, rnd(32), L.treeOf(leaves), 5).input, 3)
out.v3 = Array.from({ length: 5 }, () => JSON.parse(execFileSync(L.PROVER, ['sphincs', bytesToHex(rnd(32)).slice(2), bytesToHex(rnd(32)).slice(2)], { encoding: 'utf8' })))
console.log(`v1 ${JSON.stringify(out.v1)}\nv5 ${JSON.stringify(out.v5)}`)

// ---- 2. scanning ----

const DS_R = new TextEncoder().encode('exp-e2e-frames/19/r')
const DS_TAG = new TextEncoder().encode('exp-e2e-frames/19/view-tag')
const me = ml_kem768.keygen(rnd(64))
const k = rnd(32)
const K = keccak_256(Buffer.concat([Buffer.from(k), Buffer.from(L.TAG_KEY)]))
const others = Array.from({ length: 50 }, () => ml_kem768.keygen(rnd(64)).publicKey)
const TOTAL = 10_000
const OURS = 40
const ourAt = new Set(Array.from({ length: OURS }, (_, j) => Math.floor(((j + 0.5) * TOTAL) / OURS)))
const announcements = Array.from({ length: TOTAL }, (_, i) => {
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(ourAt.has(i) ? me.publicKey : others[i % 50], rnd(32))
  const r = keccak_256(Buffer.concat([DS_R, sharedSecret]))
  const C = bytesToHex(keccak_256(Buffer.concat([Buffer.from(K), Buffer.from(r)])))
  return { ct: cipherText, tag: sha256(Buffer.concat([DS_TAG, sharedSecret]))[0], account: ourAt.has(i) ? X.accountOf(1n, C, X.VK1, C) : X.accountOf(1n, bytesToHex(rnd(32)), X.VK1, bytesToHex(rnd(32))) }
})
const t0 = performance.now()
const found: number[] = []
let tagHits = 0
for (let i = 0; i < TOTAL; i++) {
  const a = announcements[i]
  const ss = ml_kem768.decapsulate(a.ct, me.secretKey)
  if (sha256(Buffer.concat([DS_TAG, ss]))[0] !== a.tag) continue
  tagHits++
  const r = keccak_256(Buffer.concat([DS_R, ss]))
  const C = bytesToHex(keccak_256(Buffer.concat([Buffer.from(K), Buffer.from(r)])))
  if (X.accountOf(1n, C, X.VK1, C).toLowerCase() === a.account.toLowerCase()) found.push(i)
}
const ms = performance.now() - t0
out.scan = { announcements: TOTAL, ours: OURS, found: found.length, missed: [...ourAt].filter((i) => !found.includes(i)).length, falseMatches: found.filter((i) => !ourAt.has(i)).length, viewTagPasses: tagHits, msPerAnnouncement: +(ms / TOTAL).toFixed(4), perSecond: Math.round((TOTAL * 1000) / ms) }
console.log(`scan ${JSON.stringify(out.scan)}`)
writeFileSync(join(here, 'results', `${runLabel}-bench.json`), JSON.stringify(out, null, 2) + '\n')
process.exit(0)
