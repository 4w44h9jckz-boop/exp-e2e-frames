// X7: every device lost, the wallet recovered by its guardians and the user's phrase, its backup
// reopened, and a pool note, a ticket and the account spent through two skandha nodes. The steps
// are kohaku-rs's frame-secrets examples, in the order their authors gave for one fresh seed:
// seed_wallet build, guardians setup, backup write; the seed deleted; guardians recover, backup
// reopen, seed_wallet restore. Nothing after the loss is given the funder's key.
// usage: npx tsx experiments/11-x7-recovery/run.ts [attempt-label]
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Node, type Pin, RPC_URL, buildExample, buildSkandha, chainFacts, checkout, linesNaming, loadKey, peersOf, rpc, rpcUrlOf,
  run, startNode, stopNode, until, writeConfig,
} from '../../src/e2e/index.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8')) as Record<string, Pin>
const work = join(root, 'work')
const attempt = process.argv[2] ?? new Date().toISOString()
const { privateKey } = loadKey()

const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
const dirty = (await run('git', ['status', '--porcelain', '--', 'experiments/11-x7-recovery'], { cwd: root })).trim()
if (dirty) throw new Error(`commit the experiment before a recorded run:\n${dirty}`)

console.log('checking out and building the pinned pieces')
const skandha = await checkout('skandha', pins.skandha, work)
const kohaku = await checkout('kohaku-rs', pins['kohaku-rs'], work)
await buildSkandha(skandha)
const seedWallet = await buildExample(kohaku, 'kohaku-frame-secrets', 'seed_wallet')
const guardians = await buildExample(kohaku, 'kohaku-frame-secrets', 'guardians')
const backup = await buildExample(kohaku, 'kohaku-frame-secrets', 'backup')

// The lost device's seed, the new device's files and the parties' storage live here only.
const secrets = mkdtempSync(join(tmpdir(), 'x7-'))
const lost = join(secrets, 'device', 'seed')
const state = join(secrets, 'state')
const recovered = join(secrets, 'new-device', 'recovered')
const reopened = join(secrets, 'new-device', 'reopened')
const out = join(secrets, 'out')
for (const d of [join(secrets, 'device'), state, join(secrets, 'new-device'), out]) mkdirSync(d, { recursive: true })
const digest = (p: string) => createHash('sha256').update(readFileSync(p, 'utf8').trim()).digest('hex')
const words = /\b(note 0x|mnemonic|phrase:)/i

type Step = { step: string; mode: string; withFunder: boolean; millis: number; ok: boolean; stdout: string[]; error?: string[]; record?: unknown }
const steps: Step[] = []
// Each step is one example in one mode. `withFunder` decides whether PRIVATE_KEY is set at all:
// after the loss it is set to the empty string, so a step that reads it fails to parse it.
const step = async (name: string, bin: string, mode: string, withFunder: boolean, env: Record<string, string>, recordFile: string) => {
  const t = Date.now()
  const s: Step = { step: name, mode, withFunder, millis: 0, ok: false, stdout: [] }
  try {
    const o = await run(bin, [], { cwd: secrets, env: { RUST_BACKTRACE: '0', RUST_LIB_BACKTRACE: '0', RPC_URL, MODE: mode, PRIVATE_KEY: withFunder ? privateKey : '', RECORD: join(out, recordFile), ...env } })
    s.stdout = o.split('\n').filter((l) => l.trim() && !words.test(l))
    s.ok = true
  } catch (e) {
    s.error = (e as Error).message.split('\n').filter((l) => l.trim() && !words.test(l) && !/PRIVATE_KEY=/.test(l)).slice(-8)
  }
  s.millis = Date.now() - t
  if (existsSync(join(out, recordFile))) s.record = JSON.parse(readFileSync(join(out, recordFile), 'utf8'))
  steps.push(s)
  console.log(`${name}: ${s.ok ? 'done' : 'FAILED'} in ${s.millis} ms`)
  if (!s.ok) throw new Error(`${name} failed:\n${(s.error ?? []).join('\n')}`)
  return s
}
const P45 = join(out, 'public45.json')
const P46 = join(out, 'public46.json')

const stamp = Date.now()
const config = join(work, `hegota-${stamp}.json`)
writeConfig(config)
const nodes: Node[] = []
let seeds: Record<string, boolean> = {}
try {
  // 1. The device, while it exists.
  await step('the wallet built from a fresh seed', seedWallet, 'build', true, { SEED_FILE: lost, PUBLIC: P45 }, 'build.json')
  await step('the guardians set up', guardians, 'setup', true, { SEED_FILE: lost, STATE_DIR: state, PUBLIC: P46 }, 'setup.json')
  await step('the backup written', backup, 'write', false, { SEED_FILE: lost, STATE_DIR: state, PUBLIC45: P45, PUBLIC46: P46 }, 'write.json')

  // 2. The loss: only a digest is kept, in memory, to compare.
  const lostDigest = digest(lost)
  rmSync(join(secrets, 'device'), { recursive: true, force: true })
  console.log('the device is lost')

  // 3. After the loss, without the funder.
  await step('the guardians and the phrase recover the seed', guardians, 'recover', false, { STATE_DIR: state, PUBLIC: P46, RECOVERED_SEED_FILE: recovered }, 'recover.json')
  await step('the backup reopened', backup, 'reopen', false, { STATE_DIR: state, HELPERS: '7,9', RECOVERED_SEED_FILE: reopened }, 'reopen.json')
  seeds = { recoveredEqualsLost: digest(recovered) === lostDigest, reopenedEqualsLost: digest(reopened) === lostDigest }
  console.log('seeds:', JSON.stringify(seeds))

  // 4. The nodes, and the spends through node A.
  const a = await startNode({
    dir: skandha, name: 'A', config, dataDir: join(work, `a-${stamp}`), apiPort: 14337, wsPort: 14437, p2pPort: 14000,
    log: join(work, `a-${stamp}.frames.jsonl`), out: join(work, `a-${stamp}.out`),
  })
  nodes.push(a)
  const b = await startNode({
    dir: skandha, name: 'B', config, dataDir: join(work, `b-${stamp}`), apiPort: 14338, wsPort: 14438, p2pPort: 14001,
    log: join(work, `b-${stamp}.frames.jsonl`), out: join(work, `b-${stamp}.out`), bootEnr: a.enr, handoff: true,
  })
  nodes.push(b)
  const peers = await until('the two nodes to peer, each with the other alone', async () => {
    const [pa, pb] = await Promise.all([peersOf(a), peersOf(b)])
    return pa.length === 1 && pa[0] === b.peerId && pb.length === 1 && pb[0] === a.peerId ? { a: pa, b: pb } : undefined
  }, 120_000)
  console.log(`A ${a.peerId}, B ${b.peerId}: peered`)
  const restore = await step('the new device spends the pool note, a ticket and the account', seedWallet, 'restore', false,
    { SEED_FILE: recovered, PUBLIC: P45, SEND_RPC_URL: rpcUrlOf(a) }, 'restore.json')
  const spends = (restore.record as { spends: { hash: string }[] }).spends
  const hashes = spends.map((s) => s.hash.toLowerCase())
  const removed = (n: Node, h: string) =>
    linesNaming(n.log, h).some((l) => l.event === 'head' && (l.removed as string[]).map((x) => x.toLowerCase()).includes(h))
  await until('both nodes to remove every spend as included', async () => hashes.every((h) => removed(a, h) && removed(b, h)) ? true : undefined, 180_000)

  const startLine = (n: Node) =>
    readFileSync(n.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.event === 'start')
  const record = {
    experiment: '11-x7-recovery',
    attempt,
    ranAt: new Date().toISOString(),
    repoCommit,
    pins: Object.fromEntries(Object.entries(pins).map(([k, p]) => [k, { url: p.url, commit: p.commit }])),
    client: await rpc('web3_clientVersion', []),
    commands: [
      'npx tsx experiments/11-x7-recovery/run.ts',
      `kohaku-rs ${pins['kohaku-rs'].commit.slice(0, 7)}: cargo build --release -p kohaku-frame-secrets --example seed_wallet, guardians, backup`,
      'seed_wallet MODE=build; guardians MODE=setup; backup MODE=write; the seed file deleted; guardians MODE=recover; backup MODE=reopen with HELPERS=7,9; seed_wallet MODE=restore with SEND_RPC_URL at node A',
      'skandha: node A with --frames.enable, node B with --frames.enable and --frames.handoff, booted from A',
    ],
    public45: JSON.parse(readFileSync(P45, 'utf8')),
    public46: JSON.parse(readFileSync(P46, 'utf8')),
    steps,
    seeds,
    nodes: [
      { name: 'A', peerId: a.peerId, handoff: false, peers: peers.a, start: startLine(a),
        lines: Object.fromEntries(hashes.map((h) => [h, linesNaming(a.log, h)])) },
      { name: 'B', peerId: b.peerId, handoff: true, peers: peers.b, start: startLine(b),
        lines: Object.fromEntries(hashes.map((h) => [h, linesNaming(b.log, h)])) },
    ],
    chain: Object.fromEntries(await Promise.all(hashes.map(async (h) => [h, await chainFacts(h)]))),
  }
  const results = join(here, 'results')
  mkdirSync(results, { recursive: true })
  const path = join(results, `${attempt.replace(/[^A-Za-z0-9-]/g, '-')}.json`)
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n')
  console.log(`recorded ${path}`)
} catch (e) {
  const failed = join(here, 'results', 'failed')
  mkdirSync(failed, { recursive: true })
  const path = join(failed, `${attempt.replace(/[^A-Za-z0-9-]/g, '-')}.json`)
  writeFileSync(path, JSON.stringify({ experiment: '11-x7-recovery', attempt, failedAt: new Date().toISOString(), repoCommit, steps, seeds }, null, 2) + '\n')
  console.log(`failed; what finished is in ${path}`)
  throw e
} finally {
  for (const n of nodes.reverse()) await stopNode(n.child)
  rmSync(secrets, { recursive: true, force: true })
}
