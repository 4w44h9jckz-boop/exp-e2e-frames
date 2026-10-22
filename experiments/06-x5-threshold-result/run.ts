// X5's result side: a fixed committee holding a threshold TFHE key and a threshold BLS key (this
// repository's committee/, C1) evaluates and decrypts a request and signs the result; a result
// contract that is its own sender checks the signature in its VERIFY frame; the result goes to one
// skandha node, is gossiped to a second that hands it to the chain, and is mined. Three variants
// the node must refuse go with it: the signature two members can make, the quorum's signature for
// another request, and a second result for the same request.
// usage: npx tsx experiments/06-x5-threshold-result/run.ts [attempt-label]
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keccak256, stringToHex } from 'viem'
import {
  COMMITTEE_DIR, type Node, type Pin, buildCommittee, buildSkandha, chainFacts, checkout, linesNaming, loadKey, peersOf, rpc,
  rpcUrlOf, run, startNode, stopNode, until, writeConfig,
} from '../../src/e2e/index.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8')) as Record<string, Pin>
const work = join(root, 'work')
const attempt = process.argv[2] ?? new Date().toISOString()
const { privateKey } = loadKey()

const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
const dirty = (await run('git', ['status', '--porcelain', '--', 'committee', 'experiments/06-x5-threshold-result'], { cwd: root })).trim()
if (dirty) throw new Error(`commit committee/ and this experiment before a recorded run:\n${dirty}`)

console.log('checking out and building the pinned pieces')
const skandha = await checkout('skandha', pins.skandha, work)
const kohaku = await checkout('kohaku-rs', pins['kohaku-rs'], work)
const manifest = join(here, 'rust/Cargo.toml')
if (!readFileSync(manifest, 'utf8').includes(`work/kohaku-rs-${pins['kohaku-rs'].commit.slice(0, 12)}/`))
  throw new Error('rust/Cargo.toml does not point at the pinned kohaku-rs checkout')
await buildSkandha(skandha)
const target = join(work, 'target-x5')
await run('cargo', ['build', '-q', '--release', '--manifest-path', manifest], { cwd: root, env: { CARGO_TARGET_DIR: target } })
const runner = join(target, 'release', 'x5-result-runner')
const bls = await buildCommittee('bls-committee')
await run('cargo', ['build', '--release'], { cwd: join(COMMITTEE_DIR, 'fhe-committee') })
const fhe = join(COMMITTEE_DIR, 'fhe-committee', 'target', 'release', 'fhe-committee')
console.log(`kohaku-rs at ${kohaku}`)

// The committee's half: one request, encrypted, checked off chain, evaluated, decrypted by all
// four members, then signed by a quorum. Its keys and shares stay in `dir` and are deleted.
const dir = mkdtempSync(join(tmpdir(), 'x5-'))
const CHAIN_ID = 8141
const VALUE = 41n
const ADD = 1n
const metadata = stringToHex(`X5: one request, chain ${CHAIN_ID}, ${attempt}`)
const request = keccak256(metadata)
const otherRequest = keccak256(stringToHex(`X5: another request, ${attempt}`))
const timed = async (cmd: string, args: string[]) => {
  const t = Date.now()
  const stdout = await run(cmd, args, { cwd: dir })
  return { stdout: stdout.trim(), millis: Date.now() - t }
}
const steps = {
  setup: await timed(fhe, ['setup', '--out', join(dir, 'fhe')]),
  encrypt: await timed(fhe, ['encrypt', '--public', join(dir, 'fhe/public'), '--value', `${VALUE}`, '--metadata', metadata, '--out', join(dir, 'input.bin')]),
  verifyInput: await timed(fhe, ['verify-input', '--public', join(dir, 'fhe/public'), '--input', join(dir, 'input.bin'), '--metadata', metadata]),
  evaluate: await timed(fhe, ['evaluate', '--public', join(dir, 'fhe/public'), '--input', join(dir, 'input.bin'), '--metadata', metadata, '--add', `${ADD}`, '--out', join(dir, 'result.bin')]),
  decrypt: await timed(fhe, ['decrypt', '--public', join(dir, 'fhe/public'), '--members', join(dir, 'fhe/members'), '--result', join(dir, 'result.bin'), '--out', join(dir, 'decryption.json')]),
  dkg: await timed(bls, ['dkg', '--members', '4', '--out', join(dir, 'bls')]),
}
const decryption = JSON.parse(readFileSync(join(dir, 'decryption.json'), 'utf8'))
const value = decryption.value as number
// Every bls-committee call writes its JSON even when it refuses; the exit status says whether it
// made a signature.
const sign = async (sub: string, signers: string, file: string, v = value) => {
  const ok = await run(bls, [sub, '--dir', join(dir, 'bls'), '--signers', signers, '--chain-id', `${CHAIN_ID}`, '--request', request,
    '--ciphertext', join(dir, 'result.bin'), '--value', `${v}`, '--out', join(dir, file)], { cwd: dir }).then(() => true, () => false)
  return { exitOk: ok, ...JSON.parse(readFileSync(join(dir, file), 'utf8')) }
}
const quorum = await sign('sign', '0,1,2', 'signed.json')
const below = await sign('sign-below', '0,1', 'below.json')
const second = await sign('sign', '0,1,2,3', 'second.json', value + 1)
if (!quorum.exitOk || !quorum.verified) throw new Error('the quorum did not sign')
if (second.exitOk) throw new Error('the committee signed a second result for one request')
const signed = (s: { request: string; handle: string; value: number; signatureEip2537: string }) =>
  ({ request: s.request, handle: s.handle, value: s.value, signatureEip2537: s.signatureEip2537 })
const input = join(dir, 'input.json')
writeFileSync(input, JSON.stringify({
  boardCode: readFileSync(join(here, 'contracts/ResultBoard.hex'), 'utf8').trim(),
  keyEip2537: quorum.keyEip2537,
  quorum: signed(quorum),
  below: signed(below),
  otherRequest,
}))

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

  // The runner prints no key; its record holds none.
  const out = join(work, `x5-${stamp}.json`)
  const stdout = await run(runner, [], {
    cwd: root,
    env: { PRIVATE_KEY: privateKey, SEND_RPC_URL: rpcUrlOf(a), INPUT: input, RECORD: out },
  })
  console.log(stdout)
  const sent = JSON.parse(readFileSync(out, 'utf8'))
  const hashes: string[] = [...new Set<string>(sent.sent.map((s: { hash: string }) => s.hash))]
  const removed = (n: Node, h: string) =>
    linesNaming(n.log, h).some((l) => l.event === 'head' && (l.removed as string[]).includes(h))
  await until('both nodes to remove the mined result as included', async () =>
    removed(a, sent.mined.hash) && removed(b, sent.mined.hash) ? true : undefined, 180_000)

  const startLine = (n: Node) =>
    readFileSync(n.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.event === 'start')
  const record = {
    experiment: '06-x5-threshold-result',
    attempt,
    ranAt: new Date().toISOString(),
    repoCommit,
    pins: Object.fromEntries(Object.entries(pins).map(([k, p]) => [k, { url: p.url, commit: p.commit }])),
    client: await rpc('web3_clientVersion', []),
    network: 'the committee: every member in one process on one machine, in memory, a LAN time at best; the nodes: two processes on one machine over loopback',
    commands: [
      'npx tsx experiments/06-x5-threshold-result/run.ts',
      'committee/fhe-committee: setup, encrypt, verify-input, evaluate, decrypt; committee/bls-committee: dkg, sign 0,1,2, sign-below 0,1, sign 0,1,2,3 for value + 1',
      'skandha: bun install && bun run build; node A with --frames.enable, node B with --frames.enable and --frames.handoff, booted from A',
      `cargo build --release --manifest-path experiments/06-x5-threshold-result/rust/Cargo.toml (kohaku-rs ${pins['kohaku-rs'].commit.slice(0, 7)}); run with SEND_RPC_URL at node A`,
    ],
    committee: {
      request,
      metadata,
      steps: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, { millis: v.millis, stdout: v.stdout }])),
      decryption,
      quorum: { exitOk: quorum.exitOk, verified: quorum.verified, signers: quorum.signers, quorum: quorum.quorum, message: quorum.message, namespace: quorum.namespace, keyEip2537: quorum.keyEip2537 },
      below: { exitOk: below.exitOk, verified: below.verified, signers: below.signers, belowQuorum: below.belowQuorum },
      second: { exitOk: second.exitOk, refusals: second.refusals, value: value + 1 },
    },
    nodes: [
      { name: 'A', peerId: a.peerId, handoff: false, peers: peers.a, start: startLine(a),
        lines: Object.fromEntries(hashes.map((h) => [h, linesNaming(a.log, h)])) },
      { name: 'B', peerId: b.peerId, handoff: true, peers: peers.b, start: startLine(b),
        lines: Object.fromEntries(hashes.map((h) => [h, linesNaming(b.log, h)])) },
    ],
    runner: { stdout: stdout.trim().split('\n') },
    sent,
    chain: Object.fromEntries(await Promise.all([sent.setup.hash, ...hashes].map(async (h: string) => [h, await chainFacts(h)]))),
  }
  const results = join(here, 'results')
  mkdirSync(results, { recursive: true })
  const path = join(results, `${attempt.replace(/[^A-Za-z0-9-]/g, '-')}.json`)
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n')
  console.log(`recorded ${path}`)
} finally {
  for (const n of nodes.reverse()) await stopNode(n.child)
  rmSync(dir, { recursive: true, force: true })
}
