// X8: a withdrawal from a pool, which no one signs, paid with a blind ticket bound to a one-time
// key, sent to one skandha node with the copies someone who saw it pending could make; the node
// checks each ticket and its binding before it asks its client, gossips what it admits to a second
// node, which hands it to the chain. The same copies against a ticket that names no key are sent
// first, as the control. The transactions are kohaku-rs's bound_ticket example's; this runs it
// with SEND_RPC_URL at node A and a fresh seed.
// usage: npx tsx experiments/12-x8-bound-ticket/run.ts [attempt-label]
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { english, generateMnemonic } from 'viem/accounts'
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

console.log('checking out and building the pinned pieces')
const skandha = await checkout('skandha', pins.skandha, work)
const kohaku = await checkout('kohaku-rs', pins['kohaku-rs'], work)
await buildSkandha(skandha)
const example = await buildExample(kohaku, 'kohaku-frame-secrets', 'bound_ticket')

// A fresh seed for this run only, in a file only this process reads, deleted after; never recorded.
const secrets = mkdtempSync(join(tmpdir(), 'x8-'))
const seedFile = join(secrets, 'seed')
writeFileSync(seedFile, generateMnemonic(english))
chmodSync(seedFile, 0o600)

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
    log: join(work, `b-${stamp}.frames.jsonl`), out: join(work, `b-${stamp}.out`), bootEnr: a.enr, handoff: true, claims: true,
  })
  nodes.push(b)
  const peers = await until('the two nodes to peer, each with the other alone', async () => {
    const [pa, pb] = await Promise.all([peersOf(a), peersOf(b)])
    return pa.length === 1 && pa[0] === b.peerId && pb.length === 1 && pb[0] === a.peerId ? { a: pa, b: pb } : undefined
  }, 120_000)
  console.log(`A ${a.peerId}, B ${b.peerId}: peered`)

  // The example prints no key, seed or blinding factor; its record holds none.
  const out = join(work, `x8-${stamp}.json`)
  const stdout = await run(example, [], {
    cwd: root,
    env: { PRIVATE_KEY: privateKey, SEED_FILE: seedFile, RPC_URL, SEND_RPC_URL: rpcUrlOf(a), RECORD: out },
  })
  console.log(stdout)
  const sent = JSON.parse(readFileSync(out, 'utf8'))
  const handed = [...sent.spends, ...sent.control, ...sent.binding, ...(sent.calldataCopies ?? [])] as { hash: string }[]
  const hashes = [...new Set(handed.map((t) => t.hash.toLowerCase()))]
  const mined = [...sent.spends, ...sent.control, ...sent.binding].filter((t: { block?: string }) => t.block) as { hash: string }[]
  const removed = (n: Node, h: string) =>
    linesNaming(n.log, h).some((l) => l.event === 'head' && (l.removed as string[]).map((x) => x.toLowerCase()).includes(h.toLowerCase()))
  await until('both nodes to remove every mined transaction as included', async () =>
    mined.every((t) => removed(a, t.hash) && removed(b, t.hash)) ? true : undefined, 180_000)

  const startLine = (n: Node) =>
    readFileSync(n.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.event === 'start')
  const record = {
    experiment: '12-x8-bound-ticket',
    attempt,
    ranAt: new Date().toISOString(),
    pins: Object.fromEntries(Object.entries(pins).map(([k, p]) => [k, { url: p.url, commit: p.commit }])),
    client: await rpc('web3_clientVersion', []),
    commands: [
      'npx tsx experiments/12-x8-bound-ticket/run.ts',
      'skandha: bun install && bun run build; node A with --frames.claims, node B with --frames.claims and --frames.handoff, booted from A',
      `kohaku-rs ${pins['kohaku-rs'].commit.slice(0, 7)}: cargo build --release -p kohaku-frame-secrets --example bound_ticket; run with a fresh SEED_FILE and SEND_RPC_URL at node A`,
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
  rmSync(secrets, { recursive: true, force: true })
}
