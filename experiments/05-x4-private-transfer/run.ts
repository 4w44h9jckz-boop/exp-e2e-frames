// X4: a two-in, two-out private transfer in Aztec's style of notes and nullifiers, proved here, sent to one
// skandha node with two double spends while it is pending and one after it is mined; the node
// admits the transfer, gossips it to a second node, which hands it to the chain. Each double spend
// carries a proof that verifies on its own, so a refusal is the nonce keys', not the verifier's.
// The transactions are exp-frames experiment 42's pool.ts in its --send mode; this runs it with
// node A as the node.
// usage: npx tsx experiments/05-x4-private-transfer/run.ts [attempt-label]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Node, type Pin, RPC_URL, buildSkandha, chainFacts, checkout, linesNaming, loadKey, peersOf, rpc, rpcUrlOf, run,
  startNode, stopNode, until, writeConfig,
} from '../../src/e2e/index.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8')) as Record<string, Pin>
const work = join(root, 'work')
const attempt = process.argv[2] ?? new Date().toISOString()
const { privateKey } = loadKey()
// The prover's packages, at the releases experiment 42's pins.json names.
const PROVER_PACKAGES = ['@noir-lang/noir_wasm@1.0.0-rc.6', '@noir-lang/noir_js@1.0.0-rc.6', '@aztec/bb.js@5.2.1']

console.log('checking out and building the pinned pieces')
const skandha = await checkout('skandha', pins.skandha, work)
const frames = await checkout('exp-frames', pins['exp-frames'], work)
await buildSkandha(skandha)
if (!existsSync(join(frames, 'node_modules'))) await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: frames })
const exp42 = join(frames, 'experiments', '42-noir-transfer')
// NOIR_PROVER_DIR: prove.mjs and the circuit, beside the prover's packages.
const prover = join(work, `noir-prover-${pins['exp-frames'].commit.slice(0, 12)}`)
if (!existsSync(join(prover, 'node_modules'))) {
  mkdirSync(join(prover, 'transfer', 'src'), { recursive: true })
  writeFileSync(join(prover, 'package.json'), JSON.stringify({ name: 'x4-noir-prover', private: true, type: 'module' }))
  await run('npm', ['install', '--no-audit', '--no-fund', '--save-exact', ...PROVER_PACKAGES], { cwd: prover })
}
copyFileSync(join(exp42, 'build', 'prove.mjs'), join(prover, 'prove.mjs'))
copyFileSync(join(exp42, 'Nargo.toml'), join(prover, 'transfer', 'Nargo.toml'))
copyFileSync(join(exp42, 'transfer.nr'), join(prover, 'transfer', 'src', 'main.nr'))
const tool = join(exp42, 'groth16tool', 'g16tool')
if (!existsSync(tool)) await run('go', ['build', '-o', 'g16tool', '.'], { cwd: join(exp42, 'groth16tool') })

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

  // pool.ts prints hashes and answers only; its record holds no key, note secret or witness.
  const out = join(work, `x4-${stamp}.json`)
  const stdout = await run('npx', ['tsx', 'experiments/42-noir-transfer/pool.ts', '--groth16', '--send', rpcUrlOf(a),
    '--label', `x4-${stamp}`, '--out', out], {
    cwd: frames,
    env: { PRIVATE_KEY: privateKey, RPC_URL, NOIR_PROVER_DIR: prover, G16_KEYS: 'experiments/42-noir-transfer/build/groth16', G16_TOOL: tool },
  })
  console.log(stdout)
  const sent = JSON.parse(readFileSync(out, 'utf8'))
  const steps = sent.handed as { step: string; hash: string }[]
  const hashes = [...new Set(steps.map((s) => s.hash.toLowerCase()))]
  const transfer = steps.find((s) => s.step === 'transfer')
  if (!transfer) throw new Error('no transfer in the record')
  const removed = (n: Node, h: string) =>
    linesNaming(n.log, h).some((l) => l.event === 'head' && (l.removed as string[]).map((x) => x.toLowerCase()).includes(h.toLowerCase()))
  await until('both nodes to remove the transfer as included', async () =>
    removed(a, transfer.hash) && removed(b, transfer.hash) ? true : undefined, 180_000)

  const startLine = (n: Node) =>
    readFileSync(n.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.event === 'start')
  const receipt = await rpc('eth_getTransactionReceipt', [transfer.hash])
  const record = {
    experiment: '05-x4-private-transfer',
    attempt,
    ranAt: new Date().toISOString(),
    pins: Object.fromEntries(Object.entries(pins).map(([k, p]) => [k, { url: p.url, commit: p.commit }])),
    proverPackages: PROVER_PACKAGES,
    client: await rpc('web3_clientVersion', []),
    commands: [
      'npx tsx experiments/05-x4-private-transfer/run.ts',
      'skandha: bun install && bun run build; node A with --frames.enable, node B with --frames.enable and --frames.handoff, booted from A',
      `exp-frames ${pins['exp-frames'].commit.slice(0, 7)}: npm ci; go build in experiments/42-noir-transfer/groth16tool; npx tsx experiments/42-noir-transfer/pool.ts --groth16 --send <node A> --label x4-<ms> --out <file>`,
    ],
    nodes: [
      { name: 'A', peerId: a.peerId, handoff: false, peers: peers.a, start: startLine(a),
        lines: Object.fromEntries(hashes.map((h) => [h, linesNaming(a.log, h)])) },
      { name: 'B', peerId: b.peerId, handoff: true, peers: peers.b, start: startLine(b),
        lines: Object.fromEntries(hashes.map((h) => [h, linesNaming(b.log, h)])) },
    ],
    runner: { stdout: stdout.trim().split('\n') },
    sent,
    transferFrames: (receipt?.frameReceipts ?? []).map((f: { gasUsed: string; stateGasUsed?: string; status: string }) =>
      ({ gasUsed: Number.parseInt(f.gasUsed, 16), stateGasUsed: Number.parseInt(f.stateGasUsed ?? '0x0', 16), status: f.status })),
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
