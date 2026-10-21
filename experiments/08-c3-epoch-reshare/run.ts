// C3, arm A: one ticket key held by three committees in turn, the second and third by resharing, each
// issuing a ticket that a fresh sender spends through one paymaster deployed once, through a
// skandha node that checks the ticket against the key in the paymaster's code, gossiped to a
// second that hands it to the chain. Then the first committee, with the shares it kept, issues one
// more. Arm B, in the same epochs: a fresh DKG each epoch, its key registered with a new paymaster,
// and the first committee's kept shares tried at the latest one. `measure` instead times a DKG and
// a reshare in memory for several committee sizes.
// usage: npx tsx experiments/08-c3-epoch-reshare/run.ts chain [attempt-label]
//        npx tsx experiments/08-c3-epoch-reshare/run.ts measure [attempt-label] [sizes]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Node, type Pin, buildSkandha, chainFacts, checkout, linesNaming, loadKey, peersOf, rpc, rpcUrlOf, run,
  startNode, stopNode, until, writeConfig,
} from '../../src/e2e/index.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8')) as Record<string, Pin>
const work = join(root, 'work')
const mode = process.argv[2]
if (mode !== 'chain' && mode !== 'measure') throw new Error('usage: run.ts chain|measure [attempt-label]')
const attempt = process.argv[3] ?? new Date().toISOString()
const sizes = process.argv[4] ?? '4,5,7,10,13,16,32,64,128,256'

console.log('checking out and building the pinned pieces')
const kohaku = await checkout('kohaku-rs', pins['kohaku-rs'], work)
const manifest = join(here, 'rust/Cargo.toml')
const cargo = readFileSync(manifest, 'utf8')
if (!cargo.includes(`work/kohaku-rs-${pins['kohaku-rs'].commit.slice(0, 12)}/`))
  throw new Error('rust/Cargo.toml does not point at the pinned kohaku-rs checkout')
if (!cargo.includes(`rev = "${pins['cmw-monorepo'].commit}"`)) throw new Error('rust/Cargo.toml does not patch in the pinned Commonware')
const target = join(work, 'target-c3')
await run('cargo', ['build', '-q', '--release', '--manifest-path', manifest], { cwd: root, env: { CARGO_TARGET_DIR: target } })
const runner = join(target, 'release', 'c3-reshare-runner')
console.log(`kohaku-rs at ${kohaku}`)
const stamp = Date.now()
const pinsOut = Object.fromEntries(Object.entries(pins).map(([k, p]) => [k, { url: p.url, commit: p.commit }]))
const save = (record: unknown) => {
  const dir = join(here, 'results')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${mode}-${attempt.replace(/[^A-Za-z0-9-]/g, '-')}.json`)
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n')
  console.log(`recorded ${path}`)
}

if (mode === 'measure') {
  const out = join(work, `c3-measure-${stamp}.json`)
  const stdout = await run(runner, [], { cwd: root, env: { MODE: 'measure', SIZES: sizes, RECORD: out } })
  console.log(stdout)
  save({
    experiment: '08-c3-epoch-reshare',
    mode,
    attempt,
    ranAt: new Date().toISOString(),
    pins: pinsOut,
    machine: { cpus: (await import('node:os')).cpus().length, model: (await import('node:os')).cpus()[0]?.model },
    commands: [`npx tsx experiments/08-c3-epoch-reshare/run.ts measure ${attempt} ${sizes}`],
    runner: { stdout: stdout.trim().split('\n') },
    measured: JSON.parse(readFileSync(out, 'utf8')),
  })
} else {
  const { privateKey } = loadKey()
  const skandha = await checkout('skandha', pins.skandha, work)
  await buildSkandha(skandha)
  const config = join(work, `hegota-${stamp}.json`)
  writeConfig(config)
  const nodes: Node[] = []
  try {
    const a = await startNode({
      dir: skandha, name: 'A', config, dataDir: join(work, `a-${stamp}`), apiPort: 14337, wsPort: 14437, p2pPort: 14000,
      log: join(work, `a-${stamp}.frames.jsonl`), out: join(work, `a-${stamp}.out`), claims: true,
    })
    nodes.push(a)
    const b = await startNode({
      dir: skandha, name: 'B', config, dataDir: join(work, `b-${stamp}`), apiPort: 14338, wsPort: 14438, p2pPort: 14001,
      log: join(work, `b-${stamp}.frames.jsonl`), out: join(work, `b-${stamp}.out`), bootEnr: a.enr, handoff: true,
      claims: true,
    })
    nodes.push(b)
    const peers = await until('the two nodes to peer, each with the other alone', async () => {
      const [pa, pb] = await Promise.all([peersOf(a), peersOf(b)])
      return pa.length === 1 && pa[0] === b.peerId && pb.length === 1 && pb[0] === a.peerId ? { a: pa, b: pb } : undefined
    }, 120_000)
    console.log(`A ${a.peerId}, B ${b.peerId}: peered`)

    // The runner prints no key, share or blinding factor; its record holds none.
    const out = join(work, `c3-${stamp}.json`)
    const stdout = await run(runner, [], {
      cwd: root,
      env: { MODE: 'chain', PRIVATE_KEY: privateKey, SEND_RPC_URL: rpcUrlOf(a), RECORD: out },
    })
    console.log(stdout)
    const sent = JSON.parse(readFileSync(out, 'utf8'))
    type Spend = { hash: string; admitted: boolean }
    const spends: Spend[] = sent.rounds.flatMap((r: { a: { spend: Spend }; b: { spend: Spend } }) => [r.a.spend, r.b.spend])
    const hashes = spends.map((x) => x.hash)
    const removed = (n: Node, h: string) =>
      linesNaming(n.log, h).some((l) => l.event === 'head' && (l.removed as string[]).includes(h))
    await until('both nodes to remove every admitted spend as included', async () =>
      spends.filter((x) => x.admitted).every((x) => removed(a, x.hash) && removed(b, x.hash)) ? true : undefined, 180_000)
    const startLine = (n: Node) =>
      readFileSync(n.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.event === 'start')
    save({
      experiment: '08-c3-epoch-reshare',
      mode,
      attempt,
      ranAt: new Date().toISOString(),
      pins: pinsOut,
      client: await rpc('web3_clientVersion', []),
      commands: [
        `npx tsx experiments/08-c3-epoch-reshare/run.ts chain ${attempt}`,
        'skandha: bun install && bun run build; node A with --frames.claims, node B with --frames.claims and --frames.handoff, booted from A, as FRAMES.md gives them',
        `cargo build --release --manifest-path experiments/08-c3-epoch-reshare/rust/Cargo.toml (kohaku-rs ${pins['kohaku-rs'].commit.slice(0, 7)}, Commonware from cmw-monorepo ${pins['cmw-monorepo'].commit.slice(0, 7)}); MODE=chain, SEND_RPC_URL at node A`,
      ],
      nodes: [
        { name: 'A', peerId: a.peerId, handoff: false, claims: true, peers: peers.a, start: startLine(a),
          lines: Object.fromEntries(hashes.map((h) => [h, linesNaming(a.log, h)])) },
        { name: 'B', peerId: b.peerId, handoff: true, claims: true, peers: peers.b, start: startLine(b),
          lines: Object.fromEntries(hashes.map((h) => [h, linesNaming(b.log, h)])) },
      ],
      runner: { stdout: stdout.trim().split('\n') },
      sent,
      chain: Object.fromEntries(await Promise.all(hashes.map(async (h) => [h, await chainFacts(h)]))),
    })
  } finally {
    for (const n of nodes.reverse()) await stopNode(n.child)
  }
}
