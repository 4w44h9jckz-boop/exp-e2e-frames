// C6: who signed. For each committee size, a threshold signature checked by the ticket paymaster,
// and the signers named by a bitmap with their own signatures checked by AccountablePaymaster, in
// two modes, and k ECDSA signatures as a control; each spend from a fresh sender sent to the chain,
// with its gas and bytes.
// usage: npx tsx experiments/10-c6-accountable-signers/run.ts [attempt-label] [sizes] [limit-margin-percent]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Pin, chainFacts, checkout, loadKey, rpc, run } from '../../src/e2e/index.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8')) as Record<string, Pin>
const work = join(root, 'work')
const attempt = process.argv[2] ?? new Date().toISOString()
const sizes = process.argv[3] ?? '5,10,13,16,32,64,128,256'
const { privateKey } = loadKey()

console.log('checking out and building the pinned pieces')
const kohaku = await checkout('kohaku-rs', pins['kohaku-rs'], work)
const manifest = join(here, 'rust/Cargo.toml')
const cargo = readFileSync(manifest, 'utf8')
if (!cargo.includes(`work/kohaku-rs-${pins['kohaku-rs'].commit.slice(0, 12)}/`))
  throw new Error('rust/Cargo.toml does not point at the pinned kohaku-rs checkout')
if (!cargo.includes(`rev = "${pins['cmw-monorepo'].commit}"`)) throw new Error('rust/Cargo.toml does not patch in the pinned Commonware')
const target = join(work, 'target-c6')
await run('cargo', ['build', '-q', '--release', '--manifest-path', manifest], { cwd: root, env: { CARGO_TARGET_DIR: target } })
const runner = join(target, 'release', 'c6-signers-runner')
console.log(`kohaku-rs at ${kohaku}`)

const out = join(work, `c6-${Date.now()}.json`)
const margin = process.argv[4] ?? '10'
const stdout = await run(runner, [], { cwd: root, env: { PRIVATE_KEY: privateKey, SIZES: sizes, RECORD: out, LIMIT_MARGIN: margin } })
console.log(stdout)
const sent = JSON.parse(readFileSync(out, 'utf8'))
const hashes: string[] = sent.sizes.flatMap(
  (s: { threshold: { spend: { hash: string } }; ecdsa: { spend: { hash: string } }; accountable: { spends: { hash: string }[] } }) => [
    s.threshold.spend.hash,
    s.ecdsa.spend.hash,
    ...s.accountable.spends.map((x) => x.hash),
  ],
)
const record = {
  experiment: '10-c6-accountable-signers',
  attempt,
  ranAt: new Date().toISOString(),
  pins: Object.fromEntries(Object.entries(pins).map(([k, p]) => [k, { url: p.url, commit: p.commit }])),
  client: await rpc('web3_clientVersion', []),
  commands: [
    `npx tsx experiments/10-c6-accountable-signers/run.ts ${attempt} ${sizes} ${margin}`,
    `cargo build --release --manifest-path experiments/10-c6-accountable-signers/rust/Cargo.toml (kohaku-rs ${pins['kohaku-rs'].commit.slice(0, 7)}, Commonware from cmw-monorepo ${pins['cmw-monorepo'].commit.slice(0, 7)}); every spend sent to the chain's RPC`,
  ],
  runner: { stdout: stdout.trim().split('\n') },
  sent,
  chain: Object.fromEntries(await Promise.all(hashes.map(async (h) => [h, await chainFacts(h)]))),
}
const dir = join(here, 'results')
mkdirSync(dir, { recursive: true })
const path = join(dir, `${attempt.replace(/[^A-Za-z0-9-]/g, '-')}.json`)
writeFileSync(path, JSON.stringify(record, null, 2) + '\n')
console.log(`recorded ${path}`)
