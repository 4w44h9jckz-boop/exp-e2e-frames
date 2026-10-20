// I2: one frame format across wallets. Generates nothing: it runs three implementations against
// the committed vector set in vectors/frame-tx/ and records every answer and every disagreement.
// usage: npx tsx experiments/03-i2-one-frame-format/run.ts <n-label>, which writes results/<n-label>.json
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Hex } from 'viem'
import { type Pin, checkout, run } from '../../src/e2e/index.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const work = join(root, 'work')
const vectors = join(root, 'vectors/frame-tx')
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8')) as Record<string, Pin>
const FILES = ['transactions.json', 'reject.json', 'execution-digest.json']
const load = (f: string) => JSON.parse(readFileSync(join(vectors, f), 'utf8'))
const label = process.argv[2]
if (!label || !/^[0-9]+-[a-z0-9-]+$/.test(label)) throw new Error('give the attempt as <n-label>, e.g. 2-second-run')

type Answers = {
  implementation: string
  transactions: { name: string; raw?: Hex; hash?: Hex; sigHash?: Hex; error?: string }[]
  reject: { name: string; refused: boolean; error?: string }[]
  executionDigest: { name: string; domainSeparator?: Hex; structHash?: Hex; executionDigest?: Hex; error?: string }[]
}

console.log('checking out the pinned wallets')
const framesDir = await checkout('exp-frames', pins['exp-frames'], work)
const kohakuDir = await checkout('kohaku-rs', pins['kohaku-rs'], work)

async function typescript(): Promise<Answers> {
  const lib = await import(join(framesDir, 'src/frametx/index.ts'))
  const dg = await import(join(framesDir, 'experiments/27-execution-digest/digest.ts'))
  const out: Answers = { implementation: 'exp-frames src/frametx (TypeScript)', transactions: [], reject: [], executionDigest: [] }
  for (const c of load('transactions.json').cases) {
    try {
      const tx = lib.frameTxFromJson({ ...c.fields, hash: '0x' })
      out.transactions.push({ name: c.name, raw: lib.serializeFrameTx(tx), hash: lib.frameTxHash(tx), sigHash: lib.frameSigHash(tx) })
    } catch (e) {
      out.transactions.push({ name: c.name, error: String((e as Error).message) })
    }
  }
  for (const c of load('reject.json').cases) {
    try {
      lib.parseFrameTx(c.raw)
      out.reject.push({ name: c.name, refused: false })
    } catch (e) {
      out.reject.push({ name: c.name, refused: true, error: String((e as Error).message).split('\n')[0] })
    }
  }
  for (const c of load('execution-digest.json').cases) {
    const tx = lib.parseFrameTx(c.raw)
    out.executionDigest.push({
      name: c.name,
      domainSeparator: dg.domainSeparator(tx.chainId, tx.sender),
      structHash: dg.structHash(tx),
      executionDigest: dg.executionDigest(tx),
    })
  }
  return out
}

console.log('building the Rust runner against kohaku-rs')
const manifest = join(here, 'rust/Cargo.toml')
if (!readFileSync(manifest, 'utf8').includes(`kohaku-rs-${pins['kohaku-rs'].commit.slice(0, 12)}/`))
  throw new Error('rust/Cargo.toml does not point at the pinned kohaku-rs checkout')
const target = join(work, 'i2-target')
await run('cargo', ['build', '-q', '--release', '--manifest-path', manifest], { cwd: root, env: { ...process.env, CARGO_TARGET_DIR: target } })

const answers: Answers[] = [
  await typescript(),
  JSON.parse(await run(join(target, 'release/i2-kohaku-runner'), [vectors], { cwd: root })),
  JSON.parse(await run('python3', [join(here, 'py/run.py'), vectors], { cwd: root })),
]

// Compare each answer with the expected value, case by case.
type Miss = { file: string; name: string; field: string; expected: unknown; got: unknown }
const compare = (a: Answers): Miss[] => {
  const miss: Miss[] = []
  const byName = <T extends { name: string }>(xs: T[]) => new Map(xs.map((x) => [x.name, x]))
  const tx = byName(a.transactions)
  for (const c of load('transactions.json').cases)
    for (const field of ['raw', 'hash', 'sigHash'] as const) {
      const got = tx.get(c.name)?.[field] ?? tx.get(c.name)?.error
      if (String(got).toLowerCase() !== c[field].toLowerCase()) miss.push({ file: 'transactions', name: c.name, field, expected: c[field], got })
    }
  const rej = byName(a.reject)
  for (const c of load('reject.json').cases)
    if (rej.get(c.name)?.refused !== true) miss.push({ file: 'reject', name: c.name, field: 'refused', expected: true, got: rej.get(c.name)?.refused })
  const dig = byName(a.executionDigest)
  for (const c of load('execution-digest.json').cases)
    for (const field of ['domainSeparator', 'structHash', 'executionDigest'] as const) {
      const got = dig.get(c.name)?.[field] ?? dig.get(c.name)?.error
      if (String(got).toLowerCase() !== c[field].toLowerCase()) miss.push({ file: 'execution-digest', name: c.name, field, expected: c[field], got })
    }
  return miss
}

const sha = (f: string) => createHash('sha256').update(readFileSync(join(vectors, f))).digest('hex')
const results = answers.map((a) => ({ implementation: a.implementation, misses: compare(a), answers: a }))
const record = {
  experiment: '03-i2-one-frame-format',
  attempt: label,
  ranAt: new Date().toISOString(),
  pins,
  vectors: Object.fromEntries(FILES.map((f) => [f, sha(f)])),
  cases: Object.fromEntries(FILES.map((f) => [f, load(f).cases.length])),
  commands: [
    `npx tsx experiments/03-i2-one-frame-format/run.ts ${label}`,
    `cargo build --release --manifest-path experiments/03-i2-one-frame-format/rust/Cargo.toml (kohaku-rs ${pins['kohaku-rs'].commit.slice(0, 7)})`,
    'python3 experiments/03-i2-one-frame-format/py/run.py vectors/frame-tx',
  ],
  results,
}
mkdirSync(join(here, 'results'), { recursive: true })
const out = join(here, 'results', `${label}.json`)
writeFileSync(out, JSON.stringify(record, null, 1) + '\n')
for (const r of results) {
  const by = new Map<string, number>()
  for (const m of r.misses) by.set(`${m.file}/${m.field}`, (by.get(`${m.file}/${m.field}`) ?? 0) + 1)
  console.log(`${r.implementation}: ${r.misses.length} disagreements ${JSON.stringify(Object.fromEntries(by))}`)
}
console.log(`recorded ${out}`)
