// X6: a proving committee in place of an operator. Three parts, every transaction to node A:
// - a withdrawal the device proves alone, then one whose witness the wallet shares to the
//   committee (this repository's committee/co-withdraw, C2), proved by its three members;
// - the stand-in shared-state update: CommitteeAccount is the sender, the committee's proof is
//   checked in its own VERIFY frame, a fresh payer's VERIFY frame pays;
// - the committee stopped: a note it held in shares, its members gone, then what one share, the
//   wallet's files and the chain alone can do.
// usage: npx tsx experiments/07-x6-committee-proof/run.ts [attempt-label]
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Hex, bytesToHex, decodeFunctionData, getAddress, parseAbi } from 'viem'
import {
  type Node, type Pin, buildCommittee, buildExample, buildSkandha, chainFacts, checkout, linesNaming, loadKey,
  peersOf, refundWithdrawal, rpc, rpcUrlOf, run, startNode, stopNode, until, verifierAccepts, writeConfig,
} from '../../src/e2e/index.js'
// @ts-expect-error: a plain ES module beside the contract
import { compile } from './contracts/compile.mjs'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8')) as Record<string, Pin>
const work = join(root, 'work')
const attempt = process.argv[2] ?? new Date().toISOString()
const { privateKey } = loadKey()

const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
const dirty = (await run('git', ['status', '--porcelain', '--', 'committee', 'experiments/07-x6-committee-proof'], { cwd: root })).trim()
if (dirty) throw new Error(`commit committee/ and this experiment before a recorded run:\n${dirty}`)
const accountCode = join(here, 'contracts', 'CommitteeAccount.hex')
if (readFileSync(accountCode, 'utf8').trim() !== compile()) throw new Error('CommitteeAccount.hex is not what solc makes of the Yul')

console.log('checking out and building the pinned pieces')
const skandha = await checkout('skandha', pins.skandha, work)
const kohaku = await checkout('kohaku-rs', pins['kohaku-rs'], work)
await buildSkandha(skandha)
const coWithdraw = await buildCommittee('co-withdraw')
const target = join(work, 'target-x6')
await run('cargo', ['build', '-q', '--release', '--manifest-path', join(here, 'rust', 'Cargo.toml')], { cwd: root, env: { CARGO_TARGET_DIR: target } })
const runner = join(target, 'release', 'x6-committee-runner')
const shareBin = await buildExample(kohaku, 'kohaku-witness-share', 'share_withdrawal')
const deviceBin = await buildExample(kohaku, 'kohaku-frame-pool', 'refund_withdrawal')

// Shares, notes and the stand-in's inputs live here only, and are deleted at the end.
const secrets = mkdtempSync(join(tmpdir(), 'x6-'))

/** A command whose standard error may print a note: those lines are dropped and never recorded. */
const quiet = async (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
  const t = Date.now()
  const out = await run(cmd, args, { cwd: secrets, env }).catch((e: Error) => {
    throw new Error(e.message.split('\n').filter((l) => !/note 0x/i.test(l)).join('\n'))
  })
  return { stdout: out.split('\n').filter((l) => l.trim() && !/note 0x/i.test(l)), millis: Date.now() - t }
}

/** The wallet's side: a fresh note deposited into the refund pool, its witness shared to `dir`. */
const share = (dir: string) => {
  mkdirSync(dir, { recursive: true })
  return quiet(shareBin, [], { PRIVATE_KEY: privateKey, OUT_DIR: dir })
}

/** Every frame a node and the chain see, with its receipt. */
async function frameFacts(hash: string) {
  const [tx, rc] = await Promise.all([rpc('eth_getTransactionByHash', [hash]), rpc('eth_getTransactionReceipt', [hash])])
  if (!tx) return null
  return {
    sender: tx.sender as string,
    nonceKeys: tx.nonceKeys as string[],
    nonceSeq: tx.nonceSeq as string,
    maxFeePerGas: tx.maxFeePerGas as string,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas as string,
    signatures: (tx.signatures ?? []).length as number,
    frames: (tx.frames as Record<string, string>[]).map((f, i) => ({
      mode: f.mode,
      flags: f.flags,
      to: f.to,
      gasLimit: f.gasLimit,
      stateGasLimit: f.stateGasLimit,
      value: f.value,
      dataBytes: (f.data.length - 2) / 2,
      selector: f.data.length >= 10 ? f.data.slice(0, 10) : null,
      gasUsed: rc?.frameReceipts?.[i]?.gasUsed ?? null,
      stateGasUsed: rc?.frameReceipts?.[i]?.stateGasUsed ?? null,
      status: rc?.frameReceipts?.[i]?.status ?? null,
    })),
  }
}

const WITHDRAW = parseAbi(['function withdraw(bytes proof, bytes32 root, bytes32 nullifierHash, address recipient, address relayer, uint256 fee, uint256 refund)'])
/** The proof and the six inputs in a withdrawal's SENDER frame, read back from the chain. */
async function withdrawArgs(hash: string) {
  const tx = await rpc('eth_getTransactionByHash', [hash])
  for (const f of tx.frames as { mode: string; data: Hex }[]) {
    if (f.mode !== '0x2') continue
    try {
      const { args } = decodeFunctionData({ abi: WITHDRAW, data: f.data })
      const [proof, rootWord, nullifierHash, recipient, relayer, fee, refund] = args
      return { proof, inputs: [BigInt(rootWord), BigInt(nullifierHash), BigInt(recipient), BigInt(relayer), fee, refund] }
    } catch {}
  }
  throw new Error(`no withdraw call in ${hash}`)
}

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
  const toA = { PRIVATE_KEY: privateKey, SEND_RPC_URL: rpcUrlOf(a) }
  const runnerRecord = async (args: string[], file: string) => {
    const out = join(secrets, file)
    const res = await quiet(runner, args, { ...toA, RECORD: out })
    console.log(res.stdout.join('\n'))
    return { stdout: res.stdout, ...JSON.parse(readFileSync(out, 'utf8')) }
  }

  // 1. The device proves alone.
  console.log('the device withdrawal')
  const device = await refundWithdrawal(deviceBin, { privateKey, sendRpcUrl: rpcUrlOf(a) })
  await until('the device withdrawal to be mined', async () => ((await chainFacts(device.withdrawal)).mined ? true : undefined), 300_000, 2_000)

  // 2. The committee proves the same kind of withdrawal from the wallet's shares.
  console.log('the committee withdrawal')
  const wDir = join(secrets, 'withdrawal')
  const wShare = await share(wDir)
  const wMembers = join(secrets, 'withdrawal-members.json')
  const wProve = await quiet(coWithdraw, ['local', '--shares', wDir, '--port', '10100', '--out', wMembers])
  const withdrawal = await runnerRecord(['withdraw', '--withdrawal', join(wDir, 'withdrawal.json'), '--members', wMembers], 'withdraw.json')
  const wMemberRecords = JSON.parse(readFileSync(wMembers, 'utf8'))

  // 3. The stand-in update: a note of the account's own tree, its inputs deleted once shared.
  console.log('the shared-state update')
  const recipient = getAddress(bytesToHex(randomBytes(20)))
  const inputs = join(secrets, 'inputs.json')
  const uInputs = await quiet(runner, ['inputs', '--recipient', recipient, '--out', inputs])
  const uDir = join(secrets, 'update')
  const uSplit = await quiet(coWithdraw, ['split', '--inputs', inputs, '--out-dir', uDir])
  rmSync(inputs)
  const uMembers = join(secrets, 'update-members.json')
  const uProve = await quiet(coWithdraw, ['local', '--shares', uDir, '--port', '10110', '--out', uMembers])
  const update = await runnerRecord(['update', '--members', uMembers, '--code', accountCode], 'update.json')
  const uMemberRecords = JSON.parse(readFileSync(uMembers, 'utf8'))

  // 4. The committee stops. A third note is shared and never proved: the members' shares 1 and
  // 2 are deleted, member 0 starts alone with its share, then that share is deleted too.
  console.log('the committee stopped')
  const hDir = join(secrets, 'held')
  const hShare = await share(hDir)
  for (const i of [1, 2]) rmSync(join(hDir, `share-${i}.bin`))
  const alone = await quiet('timeout', ['150', coWithdraw, 'member', '--id', '0', '--share', join(hDir, 'share-0.bin'),
    '--peers', '127.0.0.1:10120,127.0.0.1:10121,127.0.0.1:10122', '--out', join(secrets, 'alone.json')])
    .then((r) => ({ exitOk: true, millis: r.millis, tail: r.stdout.slice(-5) }))
    .catch((e: Error) => ({ exitOk: false, millis: null, tail: e.message.split('\n').slice(-5) }))
  rmSync(join(hDir, 'share-0.bin'))
  const kept = readdirSync(hDir).sort()
  const unproved = await runnerRecord(['unproved', '--withdrawal', join(hDir, 'withdrawal.json')], 'unproved.json')
  const held = JSON.parse(readFileSync(join(hDir, 'withdrawal.json'), 'utf8'))

  const mined = [device.withdrawal, withdrawal.mined.hash, update.mined.hash]
  const removed = (n: Node, h: string) =>
    linesNaming(n.log, h).some((l) => l.event === 'head' && (l.removed as string[]).map((x) => x.toLowerCase()).includes(h.toLowerCase()))
  await until('both nodes to remove every mined transaction as included', async () =>
    mined.every((h) => removed(a, h) && removed(b, h)) ? true : undefined, 180_000)

  const sentHashes = [device.withdrawal, ...[withdrawal, update, unproved].flatMap((r) => r.sent.map((s: { hash: string }) => s.hash))]
  const hashes = [...new Set(sentHashes.map((h: string) => h.toLowerCase()))]
  const setupHashes = [device.deposit, update.setup.hash].filter(Boolean) as string[]
  const startLine = (n: Node) =>
    readFileSync(n.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.event === 'start')
  const committeeProof = wMemberRecords[0].solidity as Hex
  const record = {
    experiment: '07-x6-committee-proof',
    attempt,
    ranAt: new Date().toISOString(),
    repoCommit,
    pins: Object.fromEntries(Object.entries(pins).map(([k, p]) => [k, { url: p.url, commit: p.commit }])),
    client: await rpc('web3_clientVersion', []),
    network: 'the committee: three members as threads of one process over loopback TCP, a LAN time at best; the nodes: two processes on one machine over loopback',
    commands: [
      'npx tsx experiments/07-x6-committee-proof/run.ts',
      'skandha: bun install && bun run build; node A with --frames.enable, node B with --frames.enable and --frames.handoff, booted from A',
      `kohaku-rs ${pins['kohaku-rs'].commit.slice(0, 7)}: refund_withdrawal (the device) and share_withdrawal (the wallet's shares), each with SEND_RPC_URL or OUT_DIR`,
      'committee/co-withdraw: local over each share set; split for the stand-in; member 0 alone once the committee stopped',
      'cargo build --release --manifest-path experiments/07-x6-committee-proof/rust/Cargo.toml; inputs, withdraw, update and unproved with SEND_RPC_URL at node A',
    ],
    nodes: [
      { name: 'A', peerId: a.peerId, handoff: false, peers: peers.a, start: startLine(a),
        lines: Object.fromEntries(hashes.map((h) => [h, linesNaming(a.log, h)])) },
      { name: 'B', peerId: b.peerId, handoff: true, peers: peers.b, start: startLine(b),
        lines: Object.fromEntries(hashes.map((h) => [h, linesNaming(b.log, h)])) },
    ],
    device: {
      stdout: device.stdout,
      deposit: device.deposit,
      depositBlock: device.depositBlock,
      withdrawal: device.withdrawal,
      frames: await frameFacts(device.withdrawal),
      verifierAccepts: await withdrawArgs(device.withdrawal).then((w) => verifierAccepts(w.proof, w.inputs, 'latest' as Hex)),
    },
    committee: {
      share: wShare,
      prove: { millis: wProve.millis, stdout: wProve.stdout },
      members: wMemberRecords,
      withdrawal,
      frames: await frameFacts(withdrawal.mined.hash),
      verifierAccepts: await verifierAccepts(committeeProof, wMemberRecords[0].publicInputs, 'latest' as Hex),
    },
    update: {
      recipient,
      inputs: uInputs.stdout,
      split: { millis: uSplit.millis, stdout: uSplit.stdout },
      prove: { millis: uProve.millis, stdout: uProve.stdout },
      members: uMemberRecords,
      ...update,
      frames: await frameFacts(update.mined.hash),
    },
    stopped: {
      share: hShare,
      publicInputs: held.publicInputs,
      memberAlone: alone,
      walletKept: kept,
      unproved,
    },
    chain: Object.fromEntries(await Promise.all([...setupHashes, ...hashes].map(async (h: string) => [h.toLowerCase(), await chainFacts(h)]))),
  }
  const results = join(here, 'results')
  mkdirSync(results, { recursive: true })
  const path = join(results, `${attempt.replace(/[^A-Za-z0-9-]/g, '-')}.json`)
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n')
  console.log(`recorded ${path}`)
} finally {
  for (const n of nodes.reverse()) await stopNode(n.child)
  rmSync(secrets, { recursive: true, force: true })
}
