// C2's check: the committee proves a withdrawal, and the verifier X1's pool calls accepts it.
// The client extends the witness and splits it, the three members prove over loopback TCP, and
// the chain's verifier answers an `eth_call` for the proof as made and for one public input
// changed. Nothing is sent: no key is needed. The record is written to
// test/fixtures/committee/c2-<label>.json, and `npm test` checks it offline.
// usage: npx tsx scripts/committee-c2.ts [label]
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Hex, numberToHex } from 'viem'
import { COMMITTEE_DIR, PATCHED_VERIFIER, RPC_URL, buildCommittee, codeAt, rpc, run, verifierAccepts } from '../src/e2e/index.js'

const label = process.argv[2] ?? new Date().toISOString().slice(0, 10)
const out = new URL('../test/fixtures/committee/', import.meta.url).pathname
const dir = mkdtempSync(join(tmpdir(), 'c2-'))

const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: COMMITTEE_DIR })).trim()
const dirty = (await run('git', ['status', '--porcelain', '--', '.'], { cwd: COMMITTEE_DIR })).trim()
if (dirty) throw new Error(`commit committee/ before a recorded run:\n${dirty}`)

const bin = await buildCommittee('co-withdraw')
const commands = [
  `co-withdraw demo-inputs --out inputs.json`,
  `co-withdraw split --inputs inputs.json --out-dir shares`,
  `co-withdraw local --shares shares --out members.json`,
  `co-withdraw vk --out vk.json`,
]
await run(bin, ['demo-inputs', '--out', join(dir, 'inputs.json')], { cwd: dir })
await run(bin, ['split', '--inputs', join(dir, 'inputs.json'), '--out-dir', join(dir, 'shares')], { cwd: dir })
await run(bin, ['local', '--shares', join(dir, 'shares'), '--out', join(dir, 'members.json')], { cwd: dir })
await run(bin, ['vk', '--out', join(dir, 'vk.json')], { cwd: dir })

const members = JSON.parse(readFileSync(join(dir, 'members.json'), 'utf8'))
const vk = JSON.parse(readFileSync(join(dir, 'vk.json'), 'utf8'))
const shareBytes = [0, 1, 2].map((i) => readFileSync(join(dir, 'shares', `share-${i}.bin`)).length)

const head = Number.parseInt(await rpc('eth_blockNumber', []), 16)
const block = numberToHex(head) as Hex
const { solidity, publicInputs } = members[0]
const tamperedIndex = 2
const tampered = publicInputs.map((x: string, i: number) => (i === tamperedIndex ? (BigInt(x) + 1n).toString() : x))
const verifier = await codeAt(PATCHED_VERIFIER, block)
const record = {
  entry: 'C2',
  label,
  ranAt: new Date().toISOString(),
  repoCommit,
  pins: JSON.parse(readFileSync(join(COMMITTEE_DIR, 'pins.json'), 'utf8')),
  commands,
  shareBytes,
  vk,
  members,
  chain: {
    rpc: RPC_URL,
    block: head,
    verifier: PATCHED_VERIFIER,
    verifierCodeHash: verifier.codeHash,
    verifierCode: verifier.code,
    accepts: await verifierAccepts(solidity, publicInputs, block),
    tamperedIndex,
    acceptsTampered: await verifierAccepts(solidity, tampered, block),
  },
}
mkdirSync(out, { recursive: true })
const path = join(out, `c2-${label}.json`)
writeFileSync(path, JSON.stringify(record, null, 2) + '\n')
console.log(`accepts: ${record.chain.accepts}, with input ${tamperedIndex} changed: ${record.chain.acceptsTampered}`)
console.log(`recorded ${path}`)
