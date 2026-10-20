// X3: fresh senders' spends paid with blind tickets from two issuer sets, sent to one skandha node
// that finds the ticket paymasters by their code and checks each ticket before it asks its client,
// gossiped to a second that hands them to the chain, and mined. Two spends the node must refuse go
// first: a signature that is no ticket, and a ticket of one set carried to the other set's
// paymaster.
// usage: npx tsx experiments/04-x3-ticket-paid-spend/run.ts [attempt-label]
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
const attempt = process.argv[2] ?? new Date().toISOString()
const { privateKey } = loadKey()

console.log('checking out and building the pinned pieces')
const skandha = await checkout('skandha', pins.skandha, work)
const kohaku = await checkout('kohaku-rs', pins['kohaku-rs'], work)
const manifest = join(here, 'rust/Cargo.toml')
if (!readFileSync(manifest, 'utf8').includes(`work/kohaku-rs-${pins['kohaku-rs'].commit.slice(0, 12)}/`))
  throw new Error('rust/Cargo.toml does not point at the pinned kohaku-rs checkout')
await buildSkandha(skandha)
const target = join(work, 'target-x3')
await run('cargo', ['build', '-q', '--release', '--manifest-path', manifest], { cwd: root, env: { CARGO_TARGET_DIR: target } })
const runner = join(target, 'release', 'x3-ticket-runner')
console.log(`kohaku-rs at ${kohaku}`)

const stamp = Date.now()
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
  const out = join(work, `x3-${stamp}.json`)
  const stdout = await run(runner, [], {
    cwd: root,
    env: { PRIVATE_KEY: privateKey, SEND_RPC_URL: rpcUrlOf(a), RECORD: out },
  })
  console.log(stdout)
  const sent = JSON.parse(readFileSync(out, 'utf8'))
  const spends = sent.rounds.flatMap((r: { spends: { hash: string }[] }) => r.spends)
  const hashes: string[] = [...sent.refused.map((r: { hash: string }) => r.hash), ...spends.map((s: { hash: string }) => s.hash)]
  const removed = (n: Node, h: string) =>
    linesNaming(n.log, h).some((l) => l.event === 'head' && (l.removed as string[]).includes(h))
  await until('both nodes to remove every spend as included', async () =>
    spends.every((s: { hash: string }) => removed(a, s.hash) && removed(b, s.hash)) ? true : undefined, 180_000)

  const startLine = (n: Node) =>
    readFileSync(n.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.event === 'start')
  const record = {
    experiment: '04-x3-ticket-paid-spend',
    attempt,
    ranAt: new Date().toISOString(),
    pins: Object.fromEntries(Object.entries(pins).map(([k, p]) => [k, { url: p.url, commit: p.commit }])),
    client: await rpc('web3_clientVersion', []),
    commands: [
      'npx tsx experiments/04-x3-ticket-paid-spend/run.ts',
      'skandha: bun install && bun run build; node A with --frames.claims, node B with --frames.claims and --frames.handoff, booted from A, as FRAMES.md gives them',
      `cargo build --release --manifest-path experiments/04-x3-ticket-paid-spend/rust/Cargo.toml (kohaku-rs ${pins['kohaku-rs'].commit.slice(0, 7)}); run with SEND_RPC_URL at node A`,
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
  }
  const dir = join(here, 'results')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${attempt.replace(/[^A-Za-z0-9-]/g, '-')}.json`)
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n')
  console.log(`recorded ${path}`)
} finally {
  for (const n of nodes.reverse()) await stopNode(n.child)
}
