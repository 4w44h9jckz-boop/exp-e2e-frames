// G5: one sealed comparison, out = (a > b) over two committed 64-bit bids, at the steps of the
// trust gradient this experiment runs, with the others' figures read back from the chain:
// - the MPC committee: three members prove exp-frames experiment 52's circuit with its key in
//   co-circom (REP3), and the proof settles a SealedPair session through node A;
// - the FHE committee: this repository's committee compares the two encrypted bids, decrypts,
//   and a quorum signs the bit, which experiment 06's result contract checks, through node A;
// - direct coordination and both enclave routes: exp-frames experiments 52 and 51's mined
//   transactions, read back from the chain.
// usage: npx tsx experiments/13-g5-gradient/run.ts [attempt-label]
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Hex, concatHex, keccak256, stringToHex, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
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
const quietEnv = { RUST_BACKTRACE: '0', RUST_LIB_BACKTRACE: '0', NO_COLOR: '1' }
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
const dirty = (await run('git', ['status', '--porcelain', '--', 'committee', 'experiments/13-g5-gradient', 'experiments/06-x5-threshold-result'], { cwd: root })).trim()
if (dirty) throw new Error(`commit committee/ and the experiments before a recorded run:\n${dirty}`)

console.log('checking out and building the pinned pieces')
const skandha = await checkout('skandha', pins.skandha, work)
const frames = await checkout('exp-frames', pins['exp-frames'], work)
await checkout('kohaku-rs', pins['kohaku-rs'], work)
const cosnarks = await checkout('co-snarks', pins['co-snarks'], work)
await buildSkandha(skandha)
if (!existsSync(join(frames, 'node_modules'))) await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: frames })
const target = (n: string) => ({ CARGO_TARGET_DIR: join(work, `target-${n}`) })
await run('cargo', ['build', '-q', '--release', '--bin', 'co-circom'], { cwd: cosnarks, env: target('cocircom') })
const cocircom = join(work, 'target-cocircom', 'release', 'co-circom')
await run('cargo', ['build', '-q', '--release'], { cwd: join(COMMITTEE_DIR, 'fhe-committee'), env: target('fhe') })
const fhe = join(work, 'target-fhe', 'release', 'fhe-committee')
const bls = await buildCommittee('bls-committee')
await run('cargo', ['build', '-q', '--release', '--manifest-path', join(root, 'experiments/06-x5-threshold-result/rust/Cargo.toml')], { cwd: root, env: target('x5') })
const resultRunner = join(work, 'target-x5', 'release', 'x5-result-runner')
await run('cargo', ['build', '-q', '--release', '--manifest-path', join(here, 'rust', 'Cargo.toml')], { cwd: root, env: target('g5') })
const sharesTool = join(work, 'target-g5', 'release', 'g5-shares')

// Experiment 52's own code, at the pin: the settlement, the session and the frame library.
const exp52 = join(frames, 'experiments/52-joint-comparison')
const P = await import(join(exp52, 'pair.ts'))
const F = await import(join(frames, 'src/frametx/index.ts'))
const D = await import(join(frames, 'src/deploy.ts'))
const { buildPoseidon } = await import(join(frames, 'node_modules/circomlibjs/main.js'))
const client = F.makeClient()
const chainId = BigInt(await client.getChainId())
const sha256 = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')

// The owners, derived for this run only; their keys, bids' randomness, shares and the committee's
// keys live in `secrets` and are deleted at the end.
const secrets = mkdtempSync(join(tmpdir(), 'g5-'))
const nodes: Node[] = []
try {
const derive = (l: string) => keccak256(concatHex([privateKey, toHex(`exp-e2e-frames/13/${attempt}/${l}`)]))
const aliceKey = derive('alice')
const bobKey = derive('bob')
const alice = privateKeyToAddress(aliceKey)
const bob = privateKeyToAddress(bobKey)
const BIDS = { a: 700n, b: 650n }
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
const rnd = () => BigInt(`0x${randomBytes(31).toString('hex')}`) % FIELD
const poseidon = await buildPoseidon()
const H = (x: bigint, y: bigint) => poseidon.F.toObject(poseidon([x, y])) as bigint
const [ra, rb] = [rnd(), rnd()]
const Ca = H(BIDS.a, ra)
const Cb = H(BIDS.b, rb)
const session: bigint = P.sessionOf(`e2e/13/${attempt}`)
const BOND = 10n ** 15n

type Step = { what: string; millis: number; ok: boolean; tail?: string[] }
const timed = async (what: string, cmd: string, args: string[], cwd = secrets): Promise<Step & { out: string }> => {
  const t = Date.now()
  try {
    const out = await run(cmd, args, { cwd, env: quietEnv })
    return { what, millis: Date.now() - t, ok: true, out }
  } catch (e) {
    return { what, millis: Date.now() - t, ok: false, out: '', tail: plain((e as Error).message).split('\n').filter((l) => l.trim() && !/^\s+(at |\d+:)/.test(l)).slice(-4) }
  }
}
const loopback = () => {
  const line = readFileSync('/proc/net/dev', 'utf8').split('\n').find((l) => l.trim().startsWith('lo:'))!
  const f = line.split(':')[1].trim().split(/\s+/).map(Number)
  return { rxBytes: f[0], rxPackets: f[1], txBytes: f[8], txPackets: f[9] }
}

// ---- setup, to the chain: the owners funded, the session opened and joined ----
console.log(`SealedPair ${P.pair.address}; Alice ${alice}, Bob ${bob}`)
const setup: Record<string, unknown>[] = []
const as = async (what: string, key: Hex, fs: unknown[]) => {
  const r = await D.sendFrames(client, key, fs, { label: what })
  if (!r?.hash || !r.receipt) throw new Error(`${what}: not mined`)
  setup.push({ what, hash: r.hash, block: Number(r.receipt.blockNumber), gasUsed: Number(r.receipt.gasUsed) })
}
const deadline = BigInt((await client.getBlock()).timestamp) + 3600n
await as('the funder pays Alice, Bob and the pair', privateKey, [
  F.senderFrame({ target: alice, value: 10n ** 16n, execution: 30_000n, state: 183_600n }),
  F.senderFrame({ target: bob, value: 10n ** 16n, execution: 30_000n, state: 183_600n }),
  F.senderFrame({ target: P.pair.address, value: 10n ** 16n, execution: 30_000n }),
])
await as('Alice opens the session with Ca and a bond', aliceKey, [P.openFrame(session, Ca, bob, deadline, BOND)])
await as('Bob joins with Cb and a bond', bobKey, [P.joinFrame(session, Cb, BOND)])

// ---- the MPC committee, before the nodes start, so the loopback carries nothing else ----
console.log('the MPC committee')
const ex = join(cosnarks, 'co-circom/co-circom/examples/data')
const circuit = join(exp52, 'joint.circom')
const zkey = join(exp52, 'build/joint.zkey')
const vkey = join(exp52, 'build/joint.vkey.json')
for (const i of [0, 1, 2]) {
  writeFileSync(join(secrets, `party${i}.toml`), [
    '[compiler]', 'allow_leaky_loops = false', `link_library = ["${join(frames, 'node_modules')}"]`, '',
    '[vm]', 'allow_leaky_logs = false', '',
    '[network]', `my_id = ${i}`, `bind_addr = "0.0.0.0:${10300 + i}"`, '',
    ...[0, 1, 2].flatMap((j) => ['[[network.parties]]', `id = ${j}`, `dns_name = "127.0.0.1:${10300 + j}"`, '']),
    '[network.tls]', `key = "${join(ex, `key${i}.der`)}"`, `certs = [${[0, 1, 2].map((j) => `"${join(ex, `cert${j}.der`)}"`).join(', ')}]`, '',
  ].join('\n'))
}
const C = ['--circuit', circuit, '--protocol', 'REP3', '--curve', 'BN254']
const pub = { Ca: Ca.toString(), Cb: Cb.toString(), session: session.toString() }
const attempts: Record<string, unknown>[] = []
let proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] } | undefined
let out = -1n
const before = loopback()
for (const guess of [0n, 1n]) {
  const dir = join(secrets, `guess-${guess}`)
  for (const d of ['a', 'b', 'm']) mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(join(dir, 'alice.json'), JSON.stringify({ ...pub, out: guess.toString(), a: BIDS.a.toString(), ra: ra.toString() }))
  writeFileSync(join(dir, 'bob.json'), JSON.stringify({ ...pub, out: guess.toString(), b: BIDS.b.toString(), rb: rb.toString() }))
  const split = [
    await timed('Alice splits her input', cocircom, ['split-input', '--config', join(secrets, 'party0.toml'), '--input', join(dir, 'alice.json'), ...C, '--out-dir', join(dir, 'a')]),
    await timed('Bob splits his input', cocircom, ['split-input', '--config', join(secrets, 'party0.toml'), '--input', join(dir, 'bob.json'), ...C, '--out-dir', join(dir, 'b')]),
  ]
  rmSync(join(dir, 'alice.json'))
  rmSync(join(dir, 'bob.json'))
  const merge = await Promise.all([0, 1, 2].map((i) => timed(`member ${i} merges`, cocircom, ['merge-input-shares', '--config', join(secrets, `party${i}.toml`), ...C,
    '--inputs', join(dir, 'a', `alice.json.${i}.shared`), '--inputs', join(dir, 'b', `bob.json.${i}.shared`), '--out', join(dir, 'm', `in.${i}.shared`)])))
  const t = Date.now()
  const witness = await Promise.all([0, 1, 2].map((i) => timed(`member ${i}, the witness`, 'timeout', ['300', cocircom, 'generate-witness', '-O1', '--config', join(secrets, `party${i}.toml`),
    '--input', join(dir, 'm', `in.${i}.shared`), ...C, '--out', join(dir, 'm', `w.${i}.shared`)])))
  const witnessMillis = Date.now() - t
  const record: Record<string, unknown> = { guess: Number(guess), split, merge, witness, witnessMillis }
  attempts.push(record)
  if (!witness.every((w) => w.ok)) continue
  const t2 = Date.now()
  const proving = await Promise.all([0, 1, 2].map((i) => timed(`member ${i}, the proof`, 'timeout', ['300', cocircom, 'generate-proof', 'groth16', '--config', join(secrets, `party${i}.toml`),
    '--witness', join(dir, 'm', `w.${i}.shared`), '--zkey', zkey, '--protocol', 'REP3', '--curve', 'BN254', '--out', join(dir, 'm', `proof.${i}.json`),
    ...(i === 0 ? ['--public-input', join(dir, 'public.json')] : [])])))
  record.proving = proving
  record.provingMillis = Date.now() - t2
  const verify = await timed('the proof against experiment 52\'s verifying key', cocircom, ['verify', 'groth16', '--proof', join(dir, 'm', 'proof.0.json'), '--vk', vkey, '--public-input', join(dir, 'public.json'), '--curve', 'BN254'])
  record.verify = { what: verify.what, millis: verify.millis, ok: verify.ok }
  record.publicSignals = JSON.parse(readFileSync(join(dir, 'public.json'), 'utf8'))
  const proofs = [0, 1, 2].map((i) => JSON.parse(readFileSync(join(dir, 'm', `proof.${i}.json`), 'utf8')))
  record.membersAgree = proofs.every((p) => JSON.stringify(p) === JSON.stringify(proofs[0]))
  proof = proofs[0]
  out = guess
  // Who sees the plaintext: whether two consecutive members' input shares rebuild each bid. Only
  // whether they do is recorded, never the value.
  record.rebuilt = [[0, 1], [1, 2], [2, 0]].flatMap(([i, j]) => (['a', 'b'] as const).map((name) => {
    const who = name === 'a' ? 'alice' : 'bob'
    try {
      const v = BigInt(execShares(join(dir, name, `${who}.json.${i}.shared`), join(dir, name, `${who}.json.${j}.shared`), name))
      return { members: [i, j], input: name, rebuilds: v === BIDS[name] }
    } catch (e) {
      return { members: [i, j], input: name, rebuilds: false, error: plain((e as Error).message).split('\n')[0] }
    }
  }))
  break
}
const after = loopback()
const mpc: Record<string, unknown> = {
  circuit: { path: 'experiments/52-joint-comparison/joint.circom', sha256: sha256(circuit) },
  zkey: { path: 'experiments/52-joint-comparison/build/joint.zkey', sha256: sha256(zkey) },
  vkey: JSON.parse(readFileSync(vkey, 'utf8')),
  attempts,
  out: Number(out),
  proof,
  loopback: { txBytes: after.txBytes - before.txBytes, txPackets: after.txPackets - before.txPackets,
    note: 'all three members, both directions, TLS included, over every attempt; nothing else was running on the loopback' },
  network: 'three members as three processes on one machine over loopback TCP with TLS: a LAN time at best',
}
if (!proof) throw new Error('the MPC committee made no proof')

// Who must be online: two members alone, the third never started.
const lastDir = join(secrets, `guess-${out}`)
mpc.twoMembers = await Promise.all([0, 1].map((i) => timed(`member ${i}, the witness, member 2 absent`, 'timeout', ['60', cocircom, 'generate-witness', '-O1',
  '--config', join(secrets, `party${i}.toml`), '--input', join(lastDir, 'm', `in.${i}.shared`), ...C, '--out', join(lastDir, 'm', `two.${i}.shared`)])))

function execShares(x: string, y: string, name: string): string {
  // Synchronous, so that the record can be built in one pass.
  const r = spawnSync(sharesTool, [x, y, name], { env: { ...process.env, ...quietEnv } })
  if (r.status !== 0) throw new Error(String(r.stderr))
  return String(r.stdout).trim()
}

// ---- the FHE committee ----
console.log('the FHE committee')
const fheDir = join(secrets, 'fhe')
const metaA = stringToHex(`G5: session ${session}, owner a`)
const metaB = stringToHex(`G5: session ${session}, owner b`)
const request = keccak256(stringToHex(`G5: session ${session}, chain ${chainId}`))
const otherRequest = keccak256(stringToHex(`G5: another request, ${attempt}`))
const f = (what: string, args: string[]) => timed(what, fhe, args)
const fheSteps = [
  await f('setup: the dealt key and its shares', ['setup', '--out', fheDir]),
  await f('Alice encrypts her bid with a proof of knowledge', ['encrypt', '--public', join(fheDir, 'public'), '--value', `${BIDS.a}`, '--metadata', metaA, '--out', join(secrets, 'a.bin')]),
  await f('Bob encrypts his bid with a proof of knowledge', ['encrypt', '--public', join(fheDir, 'public'), '--value', `${BIDS.b}`, '--metadata', metaB, '--out', join(secrets, 'b.bin')]),
  await f('the committee checks Alice\'s proof', ['verify-input', '--public', join(fheDir, 'public'), '--input', join(secrets, 'a.bin'), '--metadata', metaA]),
  await f('the committee checks Bob\'s proof', ['verify-input', '--public', join(fheDir, 'public'), '--input', join(secrets, 'b.bin'), '--metadata', metaB]),
  await f('the coprocessor compares', ['compare', '--public', join(fheDir, 'public'), '--a', join(secrets, 'a.bin'), '--a-metadata', metaA, '--b', join(secrets, 'b.bin'), '--b-metadata', metaB, '--out', join(secrets, 'result.bin')]),
  await f('all four members decrypt', ['decrypt', '--public', join(fheDir, 'public'), '--members', join(fheDir, 'members'), '--result', join(secrets, 'result.bin'), '--out', join(secrets, 'decryption.json')]),
]
if (!fheSteps.every((s) => s.ok)) throw new Error(`the FHE committee failed: ${JSON.stringify(fheSteps.filter((s) => !s.ok))}`)
const decryption = JSON.parse(readFileSync(join(secrets, 'decryption.json'), 'utf8'))
const dkg = await timed('the BLS key by DKG', bls, ['dkg', '--members', '4', '--out', join(secrets, 'bls')])
const sign = async (sub: string, signers: string, file: string, v: number) => {
  await run(bls, [sub, '--dir', join(secrets, 'bls'), '--signers', signers, '--chain-id', `${chainId}`, '--request', request,
    '--ciphertext', join(secrets, 'result.bin'), '--value', `${v}`, '--out', join(secrets, file)], { cwd: secrets, env: quietEnv }).then(() => true, () => false)
  return JSON.parse(readFileSync(join(secrets, file), 'utf8'))
}
const value = decryption.value as number
const quorum = await sign('sign', '0,1,2', 'signed.json', value)
const below = await sign('sign-below', '0,1', 'below.json', value)
const second = await sign('sign', '0,1,2,3', 'second.json', 1 - value)
const signed = (s: { request: string; handle: string; value: number; signatureEip2537: string }) =>
  ({ request: s.request, handle: s.handle, value: s.value, signatureEip2537: s.signatureEip2537 })
const input = join(secrets, 'input.json')
writeFileSync(input, JSON.stringify({
  boardCode: readFileSync(join(root, 'experiments/06-x5-threshold-result/contracts/ResultBoard.hex'), 'utf8').trim(),
  keyEip2537: quorum.keyEip2537,
  quorum: signed(quorum),
  below: signed(below),
  otherRequest,
}))

// ---- the nodes, and both results through node A ----
const stamp = Date.now()
const config = join(work, `hegota-${stamp}.json`)
writeConfig(config)
{
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

  // The MPC committee's settlement, and the same with the bit flipped.
  const offer = async (what: string, tx: unknown) => {
    const raw = F.serializeFrameTx(tx) as Hex
    const simulation = await F.simulateFrameTx(client, tx)
    const answer = await rpc('eth_sendRawTransaction', [raw], rpcUrlOf(a)).then((r: string) => ({ result: r }), (e: Error) => ({ error: e.message.split('\n')[0] }))
    console.log(`${what}: ${keccak256(raw)} -> ${JSON.stringify(answer)}`)
    return { what, raw, hash: keccak256(raw), simulation, answer }
  }
  const words = P.proofWords(proof)
  const settle = await offer('the MPC committee\'s settlement, its proof checked in SealedPair\'s VERIFY', P.settleTx({ chainId, session, deadline, out, proof: words }))
  if (!('result' in settle.answer)) throw new Error(`node A refused the settlement: ${JSON.stringify(settle.answer)}`)
  const flipped = await offer('the same proof with the bit flipped', P.settleTx({ chainId, session, deadline, out: 1n - out, proof: words }))
  await until('the settlement to be mined', async () => ((await chainFacts(settle.hash)).mined ? true : undefined), 300_000, 2_000)

  // The FHE committee's result, with experiment 06's variants, through experiment 06's runner.
  const resultRecord = join(secrets, 'result-record.json')
  const runnerOut = await run(resultRunner, [], { cwd: root, env: { ...quietEnv, PRIVATE_KEY: privateKey, SEND_RPC_URL: rpcUrlOf(a), INPUT: input, RECORD: resultRecord } })
  console.log(runnerOut)
  const result = JSON.parse(readFileSync(resultRecord, 'utf8'))

  const mined = [settle.hash, result.mined.hash]
  const removed = (n: Node, h: string) =>
    linesNaming(n.log, h).some((l) => l.event === 'head' && (l.removed as string[]).map((x) => x.toLowerCase()).includes(h.toLowerCase()))
  await until('both nodes to remove both results as included', async () => mined.every((h) => removed(a, h) && removed(b, h)) ? true : undefined, 180_000)

  // The steps carried from exp-frames, read back from the chain.
  const carriedTxs = {
    'direct coordination: experiment 52, S1, the joint proof settled': '0x13b84f26eeb5e26e6f3a177633b62ee7634b4c19964aacde8eb02b450b4eb108',
    'direct coordination: experiment 52, S5, one prover\'s proof settled the same way': '0xad49fd2a7df996864765f145bb51873e6b4b58bc90ef02775b5f5183c7ceefd6',
    'enclave: experiment 51, A, the output on its attestation': '0xe294edcc0ea04cba5846032f6b70ee4fae4b0bb572b174028b4d7a34e4ed7cc2',
    'enclave: experiment 51, B, the output on its proof': '0xd6a2834ce5e9ac8581672507586dc1776ff93b6d411a323ede79767c7a665540',
  }
  const frameGas = async (h: string) => {
    const r = await rpc('eth_getTransactionReceipt', [h])
    return (r?.frameReceipts ?? []).map((x: Record<string, string>) => ({ gasUsed: Number(x.gasUsed), stateGasUsed: Number(x.stateGasUsed ?? '0x0'), status: x.status }))
  }
  const carried = Object.fromEntries(await Promise.all(Object.entries(carriedTxs).map(async ([what, h]) =>
    [what, { ...(await chainFacts(h)), frames: await frameGas(h) }])))

  const hashes = [...new Set([settle.hash, flipped.hash, ...result.sent.map((s: { hash: string }) => s.hash)].map((h: string) => h.toLowerCase()))]
  const startLine = (n: Node) =>
    readFileSync(n.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.event === 'start')
  const record = {
    experiment: '13-g5-gradient',
    attempt,
    ranAt: new Date().toISOString(),
    repoCommit,
    pins: Object.fromEntries(Object.entries(pins).map(([k, p]) => [k, { url: p.url, commit: p.commit }])),
    client: await rpc('web3_clientVersion', []),
    commands: [
      'npx tsx experiments/13-g5-gradient/run.ts',
      'co-snarks: cargo build --release --bin co-circom; split-input, merge-input-shares, generate-witness -O1, generate-proof groth16, verify groth16',
      'committee/fhe-committee: setup, encrypt (two owners), verify-input, compare, decrypt; committee/bls-committee: dkg, sign 0,1,2, sign-below 0,1, sign 0,1,2,3 for the other bit',
      'experiment 06\'s runner with SEND_RPC_URL at node A; exp-frames experiment 52\'s pair.ts for the session and the settlement',
      'skandha: node A with --frames.enable, node B with --frames.enable and --frames.handoff, booted from A',
    ],
    function: { what: 'out = (a > b) over two committed 64-bit bids', session: session.toString(), Ca: Ca.toString(), Cb: Cb.toString(), sealedPair: P.pair.address, alice, bob, deadline: deadline.toString() },
    setup,
    mpc: { ...mpc, settle, flipped, settleFrames: await frameGas(settle.hash) },
    fhe: {
      steps: fheSteps.map(({ what, millis, ok, tail }) => ({ what, millis, ok, tail })),
      decryption,
      dkg: { millis: dkg.millis, ok: dkg.ok },
      quorum: { verified: quorum.verified, signers: quorum.signers, keyEip2537: quorum.keyEip2537, value: quorum.value },
      below: { verified: below.verified, signers: below.signers, belowQuorum: below.belowQuorum },
      second: { refusals: second.refusals, value: 1 - value },
      request,
      network: 'the committee: every member in one process on one machine, in memory; a LAN time at best',
      result,
      resultFrames: await frameGas(result.mined.hash),
    },
    carried,
    nodes: [
      { name: 'A', peerId: a.peerId, handoff: false, peers: peers.a, start: startLine(a),
        lines: Object.fromEntries(hashes.map((h) => [h, linesNaming(a.log, h)])) },
      { name: 'B', peerId: b.peerId, handoff: true, peers: peers.b, start: startLine(b),
        lines: Object.fromEntries(hashes.map((h) => [h, linesNaming(b.log, h)])) },
    ],
    chain: Object.fromEntries(await Promise.all([...setup.map((s) => s.hash as string), result.setup.hash, ...hashes].map(async (h: string) => [h.toLowerCase(), await chainFacts(h)]))),
  }
  const results = join(here, 'results')
  mkdirSync(results, { recursive: true })
  const path = join(results, `${attempt.replace(/[^A-Za-z0-9-]/g, '-')}.json`)
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n')
  console.log(`recorded ${path}`)
}
} finally {
  for (const n of nodes.reverse()) await stopNode(n.child)
  rmSync(secrets, { recursive: true, force: true })
}
