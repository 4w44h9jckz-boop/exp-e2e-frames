// X2: experiment 01's withdrawal, listed by a skandha includer under a budget per list. While the
// withdrawal is pending, both nodes are asked for the inclusion list they would publish, under each
// fill; the run records every list that names it, and one that does not, from each node.
// usage: npx tsx experiments/02-x2-inclusion-list/run.ts [attempt-label]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type InclusionList, type Node, type Pin, buildExample, buildSkandha, chainFacts, checkout, inclusionListOf,
  linesNaming, loadKey, peersOf, refundWithdrawal, rpc, rpcUrlOf, sleep, startNode, stopNode, until,
  writeConfig, writeRecord,
} from '../../src/e2e/index.js'

const here = new URL('.', import.meta.url).pathname
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8')) as Record<string, Pin>
const work = new URL('../../work/', import.meta.url).pathname
const attempt = process.argv[2] ?? new Date().toISOString()
const { privateKey } = loadKey()
const FILLS = ['eip-8369', 'ethrex'] as const

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

  // Ask both nodes for their lists, under each fill, until the sender returns.
  const asked: { node: string; focil: string; at: string; list: InclusionList }[] = []
  let sending = true
  const poll = (async () => {
    while (sending) {
      for (const n of [a, b])
        for (const focil of FILLS)
          await inclusionListOf(n, focil)
            .then((list) => asked.push({ node: n.name, focil, at: new Date().toISOString(), list }))
            .catch(() => undefined)
      await sleep(250)
    }
  })()
  const sent = await refundWithdrawal(sender, { privateKey, sendRpcUrl: rpcUrlOf(a) }).finally(() => (sending = false))
  await poll
  const hash = sent.withdrawal
  console.log(`withdrawal ${hash} handed to A only; asked for ${asked.length} lists`)
  const removed = (n: Node) =>
    linesNaming(n.log, hash).some((l) => l.event === 'head' && (l.removed as string[]).includes(hash))
  await until('both nodes to remove it as included', async () => (removed(a) && removed(b) ? true : undefined), 180_000)

  // Keep every list that names the withdrawal, and the last one before it from each node and fill.
  const names = (l: InclusionList) => l.hashes.map((h) => h.toLowerCase()).includes(hash.toLowerCase())
  const kept = asked.filter((x) => names(x.list))
  for (const n of ['A', 'B'])
    for (const focil of FILLS) {
      const before = asked.filter((x) => x.node === n && x.focil === focil && !names(x.list)).at(0)
      if (before) kept.push(before)
    }
  const chain = await chainFacts(hash)
  const path = writeRecord(hash, {
    experiment: '02-x2-inclusion-list',
    attempt,
    ranAt: new Date().toISOString(),
    pins: Object.fromEntries(Object.entries(pins).map(([k, p]) => [k, { url: p.url, commit: p.commit }])),
    client: await rpc('web3_clientVersion', []),
    commands: [
      'npx tsx experiments/02-x2-inclusion-list/run.ts',
      'skandha: bun install && bun run build; two nodes as FRAMES.md gives them, B with --frames.handoff and booted from A',
      'skandha_frameInclusionList with {"focil": "eip-8369"} and {"focil": "ethrex"} on both nodes every 250 ms while the sender runs',
      'kohaku-rs: cargo build --release -p kohaku-frame-pool --example refund_withdrawal; run with SEND_RPC_URL at node A',
    ],
    nodes: [
      { name: 'A', peerId: a.peerId, handoff: false, peers: peers.a, lines: linesNaming(a.log, hash) },
      { name: 'B', peerId: b.peerId, handoff: true, peers: peers.b, lines: linesNaming(b.log, hash) },
    ],
    sender: { stdout: sent.stdout, deposit: sent.deposit, depositBlock: sent.depositBlock },
    expect: 'mined',
    expectListed: true,
    inclusionLists: kept,
    chain,
  })
  const listed = kept.filter((x) => names(x.list))
  console.log(`recorded ${path}: listed ${listed.length} times (${[...new Set(listed.map((x) => `${x.node}/${x.focil}`))].join(', ')})`)
  console.log(JSON.stringify(chain))
} finally {
  for (const n of nodes.reverse()) await stopNode(n.child)
}
