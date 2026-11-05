// Experiment 24 (X17), arms A and B on the Hegota test network (README, "Design").
//
//   A  Tornado Cash as deployed (experiment 19's Pool4.yul): a deposit; the fresh recipient, which
//      holds no ETH, tries to send its own withdrawal; then a relayer's account sends it, for
//      experiment 30's median fee on the 0.1 ETH pool, in basis points of the note.
//   B  The same circuit, verifier and tree in PoolSelf.yul: two deposits, and two withdrawals the
//      pool sends and pays for itself, frames [VERIFY, SENDER withdraw, DEFAULT refund].
//      - The first goes to node C, which runs EIP-8141's own rules (skandha's eip-8141.json), and
//        then to node A, under the test network's profile, with node B up and peered.
//      - Node A is then stopped, and the second goes to node B alone.
//      Each node hands what it admits to the chain itself; nothing is sent to the chain directly.
//
// usage: npx tsx experiments/24-x17-a-private-withdrawal-with-and-without-a-relayer/run.ts <n>-<label>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildBabyjub, buildPedersenHash } from 'circomlibjs'
import * as snarkjs from 'snarkjs'
import { type Address, type Hex, bytesToHex, createWalletClient, decodeFunctionData, hexToBigInt, http } from 'viem'
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts'
import { type Node, type Pin, buildSkandha, checkout, linesNaming, loadKey, peersOf, rpcUrlOf, run, startNode, stopNode, until, writeConfig } from '../../src/e2e/index.js'
import { sendFrames } from '../../src/exp-frames/deploy.js'
import { type FrameTx, frameReceiptGas, frameReceiptStatus, frameTxHash, hegotaTestnet, makeClient, serializeFrameTx, simulateFrameTx, waitForFrameTxReceipt } from '../../src/exp-frames/frametx/index.js'
import { proofWords, treeOf as mimcTree } from '../15-x10-out-and-back/x10.js'
import * as X14 from '../19-x14-hash-based-stealth-addresses-under-8288/x14.js'
import * as X from './x17.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const work = join(root, 'work')
const build19 = join(root, 'experiments/19-x14-hash-based-stealth-addresses-under-8288/build')
const runLabel = process.argv[2]
if (!runLabel || !/^\d+-[a-z0-9-]+$/.test(runLabel)) throw new Error('usage: run.ts <n>-<label>')
mkdirSync(join(here, 'results'), { recursive: true })
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8')) as Record<string, Pin>
const { privateKey, address: funder } = loadKey()
const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
const dirty = (await run('git', ['status', '--porcelain', '--', X.DIR, 'src', 'experiments/19-x14-hash-based-stealth-addresses-under-8288'], { cwd: root })).trim()
if (dirty) throw new Error(`commit the experiment before a recorded run:\n${dirty}`)

const chain = makeClient()
const chainId = BigInt(await chain.getChainId())
const wallet = createWalletClient({ account: privateKeyToAccount(privateKey), chain: hegotaTestnet, transport: http() })
const secrets: string[] = [privateKey]
const keyFor = (l: string) => { const k = X.keyOf(privateKey, l); secrets.push(k); return k }
const fresh = (l: string): Address => privateKeyToAddress(keyFor(`fresh/${l}`))
const scalar = (l: string) => hexToBigInt(keyFor(`note/${l}`)) >> 8n // 31 bytes, as Tornado's notes
const setup: Record<string, unknown>[] = []
const rows: Record<string, unknown>[] = []

// Experiment 30's median relayed fee on Tornado's 0.1 ETH pool: 0.002080 ETH, so 208 basis points.
const FEE_A_BPS = 208n
const FEE_A = (X.DENOM * FEE_A_BPS) / 10_000n
// Arm B's fee: fixed before the proof, at least the transaction's maximum cost (PoolSelf.yul).
const FEE_B = 200_000_000n

// ---- notes and proofs ----

const pedersen = await buildPedersenHash()
const babyJub = await buildBabyjub()
const leInt = (x: bigint, n: number) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) { b[i] = Number(x & 0xffn); x >>= 8n } return b }
const ph = (b: Buffer) => babyJub.F.toObject(babyJub.unpackPoint(pedersen.hash(b))[0]) as bigint
function note(l: string) {
  const nullifier = scalar(`${l}/nullifier`)
  const secret = scalar(`${l}/secret`)
  return { nullifier, secret, commitment: ph(Buffer.concat([leInt(nullifier, 31), leInt(secret, 31)])), nullifierHash: ph(leInt(nullifier, 31)) }
}
async function prove(n: ReturnType<typeof note>, leaves: bigint[], index: number, recipient: Address, relayer: Address, fee: bigint) {
  const tree = mimcTree(leaves)
  const p = tree.path(index)
  const input = { root: tree.root, nullifierHash: n.nullifierHash, recipient: hexToBigInt(recipient), relayer: hexToBigInt(relayer), fee, refund: 0n, nullifier: n.nullifier, secret: n.secret, pathElements: p.pathElements, pathIndices: p.pathIndices }
  const t0 = Date.now()
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(Object.fromEntries(Object.entries(input).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)])), join(build19, 'withdraw_js/withdraw.wasm'), join(build19, 'withdraw.zkey'))
  const proveMs = Date.now() - t0
  if (!(await snarkjs.groth16.verify(X14.VKEY4, publicSignals, proof))) throw new Error('snarkjs refuses its own proof')
  return { words: proofWords(proof), root: X.word(tree.root), proveMs }
}

// ---- deployment ----

async function setupTx(what: string, frames: Parameters<typeof sendFrames>[2]) {
  const r = await sendFrames(chain, privateKey, frames, { label: what })
  if (!r?.hash || !r.receipt) throw new Error(`${what}: not mined`)
  const ok = r.receipt.frameReceipts.every((f) => frameReceiptStatus(f) === 1)
  setup.push({ what, hash: r.hash, block: Number(BigInt(r.receipt.blockNumber)), gasUsed: Number(BigInt(r.receipt.gasUsed)), ok })
  if (!ok) throw new Error(`${what}: a frame failed`)
  return Number(BigInt(r.receipt.blockNumber))
}
for (const c of [X.verifier, X.poolA, X.poolB]) {
  const code = await chain.getCode({ address: c.address })
  if (code && code !== '0x') throw new Error(`${c.label} already deployed: set X17_DEPLOYMENT to a fresh tag`)
}
const firstBlock = await setupTx('deploy the verifier and both pools', [X.verifier.deploy, X.poolA.deploy, X.poolB.deploy])

async function deposit(pool: Address, l: string, n: ReturnType<typeof note>) {
  const hash = await wallet.writeContract({ address: pool, abi: X.poolAbi, functionName: 'deposit', args: [X.word(n.commitment)], value: X.DENOM, gas: 1_500_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 1n } as never)
  const r = await chain.waitForTransactionReceipt({ hash, timeout: 180_000 })
  setup.push({ what: `${l}: deposit`, hash, block: Number(r.blockNumber), gasUsed: Number(r.gasUsed), ok: r.status === 'success' })
  if (r.status !== 'success') throw new Error(`${l}: deposit reverted`)
}

// ---- arm A: Tornado as deployed, a relayer ----

{
  const n = note('a/0')
  await deposit(X.poolA.address, 'A', n)
  const recipient = fresh('a/0')
  const p = await prove(n, [n.commitment], 0, recipient, funder, FEE_A)
  const args = [p.words, p.root, X.word(n.nullifierHash), recipient, funder, FEE_A, 0n] as const

  // The recipient, which holds no ETH, sends its own withdrawal.
  const self = createWalletClient({ account: privateKeyToAccount(keyFor('fresh/a/0')), chain: hegotaTestnet, transport: http() })
  let selfAnswer: string
  try {
    await self.writeContract({ address: X.poolA.address, abi: X.poolAbi, functionName: 'withdraw', args, gas: 900_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 1n } as never)
    selfAnswer = 'accepted'
  } catch (e) { selfAnswer = String((e as { details?: string }).details ?? (e as Error).message).slice(0, 300) }
  const balance = await chain.getBalance({ address: recipient })
  rows.push({ arm: 'A', step: 'the recipient sends its own withdrawal, holding no ETH', recipient, recipientBalance: balance.toString(), answer: selfAnswer })
  console.log(`A, the recipient alone: ${selfAnswer}`)

  // The relayer's account sends it, and takes the fee.
  const hash = await wallet.writeContract({ address: X.poolA.address, abi: X.poolAbi, functionName: 'withdraw', args, gas: 900_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 1n } as never)
  const r = await chain.waitForTransactionReceipt({ hash, timeout: 180_000 })
  const tx = await chain.getTransaction({ hash })
  const d = decodeFunctionData({ abi: X.poolAbi, data: tx.input })
  const names = X.namesIn({ from: tx.from, targets: [tx.to ?? null], recipient: d.args![3] as Address, relayer: d.args![4] as Address })
  rows.push({
    arm: 'A', step: 'a relayer sends the withdrawal', outcome: r.status === 'success' ? 'mined' : 'reverted', hash, block: Number(r.blockNumber), gasUsed: Number(r.gasUsed), type: tx.type,
    fee: FEE_A.toString(), feeBps: Number(FEE_A_BPS), recipientGot: (X.DENOM - FEE_A).toString(), proveMs: p.proveMs,
    names, relayer: funder, admission: 'the execution client\'s own pool, over the test network\'s RPC: skandha takes frame transactions only',
  })
  console.log(`A, the relayer: ${hash} block ${r.blockNumber} gasUsed ${r.gasUsed}`)
  if (r.status !== 'success') throw new Error('A: the relayer\'s withdrawal reverted')
}

// ---- arm B: the pool sends and pays for its own withdrawal ----

const skandha = await checkout('skandha', pins.skandha, work)
await buildSkandha(skandha)
const stamp = Date.now()
const config = join(work, `x17-${stamp}.json`)
writeConfig(config)
const canonical = join(skandha, 'packages/framepool/test/descriptors/eip-8141.json')
const nodes: Node[] = []
const lastBlockBefore = Number(await chain.getBlockNumber())

async function sendTo(node: Node, raw: Hex): Promise<string> {
  try {
    const res = await fetch(rpcUrlOf(node), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }) })
    const body = (await res.json()) as { result?: string; error?: unknown }
    return body.error ? `refused: ${JSON.stringify(body.error).slice(0, 400)}` : `admitted: ${body.result}`
  } catch (e) { return `unreachable: ${(e as Error).message.slice(0, 200)}` }
}

async function armB(step: string, tx: FrameTx, via: Node[], watch: Node[]) {
  const sim = await simulateFrameTx(chain, tx)
  const simRow = { valid: sim.valid, violation: sim.violation, executionStatus: sim.executionStatus, gasUsed: sim.gasUsed }
  if (!sim.valid || sim.executionStatus !== 'success') throw new Error(`${step}: the client's simulation does not admit it: ${JSON.stringify(simRow)}`)
  const raw = serializeFrameTx(tx)
  const hash = frameTxHash(tx)
  const answers: Record<string, string> = {}
  for (const node of via) { answers[node.name] = await sendTo(node, raw); console.log(`${step}, node ${node.name}: ${answers[node.name]}`) }
  const r = await waitForFrameTxReceipt(chain, hash, { timeoutMs: 180_000 }).catch(() => undefined)
  const frames = r ? r.frameReceipts.map((f) => ({ status: frameReceiptStatus(f), ...frameReceiptGas(f) })) : []
  const d = decodeFunctionData({ abi: X.poolAbi, data: tx.frames[1].data })
  const names = X.namesIn({ from: tx.sender, targets: tx.frames.map((f) => f.target), recipient: d.args![3] as Address, relayer: d.args![4] as Address })
  const seen = Object.fromEntries(watch.map((n) => [n.name, linesNaming(n.log, hash).slice(0, 6)]))
  const row = {
    arm: 'B', step, outcome: r ? (frames.every((f) => f.status === 1) ? 'mined' : 'mined, a frame failed') : 'not mined in 180 s', hash,
    block: r ? Number(BigInt(r.blockNumber)) : null, gasUsed: r ? Number(BigInt(r.gasUsed)) : null,
    frames: frames.map((f) => ({ status: f.status, execution: Number(f.execution), state: Number(f.state) })),
    simulation: simRow, answers, seen, names, fee: FEE_B.toString(),
  }
  rows.push(row)
  console.log(`${step}: ${row.outcome}${r ? ` block ${row.block} gasUsed ${row.gasUsed} frames ${row.frames.map((f) => `${f.status}:${f.execution}+${f.state}s`).join(' / ')}` : ''}`)
  return row
}

try {
  const c = await startNode({ dir: skandha, name: 'C', config, dataDir: join(work, `c-${stamp}`), apiPort: 15339, wsPort: 15439, p2pPort: 15002, log: join(work, `c-${stamp}.frames.jsonl`), out: join(work, `c-${stamp}.out`), descriptor: canonical })
  nodes.push(c)
  const a = await startNode({ dir: skandha, name: 'A', config, dataDir: join(work, `a-${stamp}`), apiPort: 15337, wsPort: 15437, p2pPort: 15000, log: join(work, `a-${stamp}.frames.jsonl`), out: join(work, `a-${stamp}.out`), handoff: true })
  nodes.push(a)
  const b = await startNode({ dir: skandha, name: 'B', config, dataDir: join(work, `b-${stamp}`), apiPort: 15338, wsPort: 15438, p2pPort: 15001, log: join(work, `b-${stamp}.frames.jsonl`), out: join(work, `b-${stamp}.out`), bootEnr: a.enr, handoff: true })
  nodes.push(b)
  await until('nodes A and B to peer, each with the other alone', async () => {
    const [pa, pb] = await Promise.all([peersOf(a), peersOf(b)])
    return pa.length === 1 && pa[0] === b.peerId && pb.length === 1 && pb[0] === a.peerId ? true : undefined
  }, 120_000)

  const n1 = note('b/1')
  const n2 = note('b/2')
  await deposit(X.poolB.address, 'B, note 1', n1)
  await deposit(X.poolB.address, 'B, note 2', n2)
  const leaves = [n1.commitment, n2.commitment]

  const r1 = fresh('b/1')
  const p1 = await prove(n1, leaves, 0, r1, X.poolB.address, FEE_B)
  await armB('B, withdrawal 1: node C (EIP-8141\'s own rules), then node A with B up', X.withdrawSelfTx(chainId, p1.words, p1.root, X.word(n1.nullifierHash), r1, FEE_B), [c, a], [a, b, c])

  await stopNode(a.child)
  nodes.splice(nodes.indexOf(a), 1)
  const r2 = fresh('b/2')
  const p2 = await prove(n2, leaves, 1, r2, X.poolB.address, FEE_B)
  await armB('B, withdrawal 2: node B alone, A stopped', X.withdrawSelfTx(chainId, p2.words, p2.root, X.word(n2.nullifierHash), r2, FEE_B), [b], [b])
} finally {
  for (const n of nodes) await stopNode(n.child)
}

// ---- the record ----

const lastBlock = Number(await chain.getBlockNumber())
const record = {
  experiment: 24, run: runLabel, date: new Date().toISOString(), repoCommit, pins, chainId: Number(chainId),
  command: `npx tsx ${X.DIR}/run.ts ${runLabel}`, deployment: X.DEPLOYMENT,
  contracts: { verifier: X.verifier.address, poolA: X.poolA.address, poolB: X.poolB.address },
  fees: { armA: { wei: FEE_A.toString(), bps: Number(FEE_A_BPS), source: 'exp-frames experiment 30, the median relayed fee on Tornado Cash\'s 0.1 ETH pool, 0.002080 ETH' }, armB: { wei: FEE_B.toString(), rule: 'at least the transaction\'s maximum cost, refunded above the charge' } },
  nodes: { A: 'the test network\'s profile, hands off', B: 'the test network\'s profile, booted from A, hands off', C: 'EIP-8141\'s own rules, skandha\'s eip-8141.json, alone' },
  blocks: { first: firstBlock, beforeNodes: lastBlockBefore, last: lastBlock },
  setup, rows,
}
let text = JSON.stringify(record, null, 2)
for (const s of secrets) if (text.toLowerCase().includes(s.slice(2).toLowerCase())) throw new Error('a secret would be recorded')
text += '\n'
writeFileSync(join(here, 'results', `${runLabel}.json`), text)
console.log(`recorded results/${runLabel}.json`)
process.exit(0)
