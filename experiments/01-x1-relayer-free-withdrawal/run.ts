// X1: a privacy withdrawal with no relayer and no sequencer. A Rust wallet proves it; it is handed to
// one skandha node alone, gossiped to a second, which alone passes it to the client; the chain mines it.
// usage: npx tsx experiments/01-x1-relayer-free-withdrawal/run.ts [attempt-label]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Node, type Pin, buildExample, buildSkandha, chainFacts, checkout, linesNaming, loadKey, peersOf,
  refundWithdrawal, rpc, rpcUrlOf, startNode, stopNode, until, writeConfig, writeRecord,
} from '../../src/e2e/index.js'

const here = new URL('.', import.meta.url).pathname
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8')) as Record<string, Pin>
const work = new URL('../../work/', import.meta.url).pathname
const attempt = process.argv[2] ?? new Date().toISOString()
const { privateKey } = loadKey()

console.log('checking out and building the pinned pieces')
const skandha = await checkout('skandha', pins.skandha, work)
const kohaku = await checkout('kohaku-rs', pins['kohaku-rs'], work)
await buildSkandha(skandha)
const sender = await buildExample(kohaku, 'kohaku-frame-pool', 'refund_withdrawal')

const stamp = Date.now()
const config = join(work, `hegota-${stamp}.json`)
writeConfig(config)
const nodes: Node[] = []
try {
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

  const sent = await refundWithdrawal(sender, { privateKey, sendRpcUrl: rpcUrlOf(a) })
  const hash = sent.withdrawal
  console.log(`withdrawal ${hash} handed to A only`)
  const removed = (n: Node) =>
    linesNaming(n.log, hash).some((l) => l.event === 'head' && (l.removed as string[]).includes(hash))
  const refused = () => linesNaming(a.log, hash).some((l) => l.event === 'rpc' && l.result !== 'ok')
  await until('both nodes to remove it as included, or A to refuse it', async () =>
    (removed(a) && removed(b)) || refused() ? true : undefined, 180_000)
  const chain = await chainFacts(hash)
  const path = writeRecord(hash, {
    experiment: '01-x1-relayer-free-withdrawal',
    attempt,
    ranAt: new Date().toISOString(),
    pins: Object.fromEntries(Object.entries(pins).map(([k, p]) => [k, { url: p.url, commit: p.commit }])),
    client: await rpc('web3_clientVersion', []),
    commands: [
      'npx tsx experiments/01-x1-relayer-free-withdrawal/run.ts',
      'skandha: bun install && bun run build; two nodes as FRAMES.md gives them, B with --frames.handoff and booted from A',
      'kohaku-rs: cargo build --release -p kohaku-frame-pool --example refund_withdrawal; run with SEND_RPC_URL at node A',
    ],
    nodes: [
      { name: 'A', peerId: a.peerId, handoff: false, peers: peers.a, lines: linesNaming(a.log, hash) },
      { name: 'B', peerId: b.peerId, handoff: true, peers: peers.b, lines: linesNaming(b.log, hash) },
    ],
    sender: { stdout: sent.stdout, deposit: sent.deposit, depositBlock: sent.depositBlock },
    expect: 'mined',
    chain,
  })
  console.log(`recorded ${path}`)
  console.log(JSON.stringify(chain))
} finally {
  for (const n of nodes.reverse()) await stopNode(n.child)
}
