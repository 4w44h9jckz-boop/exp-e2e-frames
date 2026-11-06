// Experiment 22 (Q1), the smoke run before the rebuild (README, Amendment 1): one transfer from a
// leanSPHINCS account funded at genesis to a fresh address, on the local chain with EIP-8288 as
// written, sent to skandha node A, which gossips it to node B; both hand off to the chain. The
// account's signature over the transaction's signature hash goes to the block builder's witness
// directory before the transaction is sent, and the block's proof checks it. No secp256k1 key is
// used anywhere.
//
// usage: npx tsx experiments/22-q1-leansphincs-senders/smoke.ts <n>-<label>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Address, type Hex, bytesToHex, concatHex, encodeFunctionData, getAddress, keccak256, parseAbi } from 'viem'
import { type Node, type Pin, buildSkandha, checkout, linesNaming, peersOf, rpcUrlOf, run, startLocalChain, startNode, stopNode, until, writeConfig } from '../../src/e2e/index.js'
import { compileYul } from '../../src/exp-frames/contracts.js'
import { Approve, type FrameTx, NEW_ACCOUNT_STATE_GAS, frameReceiptGas, frameReceiptStatus, frameSigHash, frameTxHash, getNonceSeq, senderFrame, serializeFrameTx, simulateFrameTx, verifyFrame, waitForFrameTxReceipt } from '../../src/exp-frames/frametx/index.js'
import * as L from '../19-x14-hash-based-stealth-addresses-under-8288/lean.js'
import * as X14 from '../19-x14-hash-based-stealth-addresses-under-8288/x14.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const DIR = 'experiments/22-q1-leansphincs-senders'
const label = process.argv[2]
if (!label || !/^\d+-[a-z0-9-]+$/.test(label)) throw new Error('usage: smoke.ts <n>-<label>')
mkdirSync(join(here, 'results'), { recursive: true })
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8')) as Record<string, Pin>
const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
const dirty = (await run('git', ['status', '--porcelain', '--', DIR, 'src'], { cwd: root })).trim()
if (dirty) throw new Error(`commit the experiment before a recorded run:\n${dirty}`)

// ---- the account: a fresh leanSPHINCS key, its code at genesis ----

const seed = crypto.getRandomValues(new Uint8Array(32))
const secrets = [bytesToHex(seed)]
const key = bytesToHex(L.sphincsKey(seed)) as Hex
if ((key.length - 2) / 2 !== 32) throw new Error(`a leanSPHINCS key is 32 bytes here, not ${(key.length - 2) / 2}`)
const account = getAddress(`0x${keccak256(concatHex(['0x22', key])).slice(-40)}`)
const runtime = compileYul(`${DIR}/contracts/SphincsAccount.yul`)
const code = concatHex([runtime, `0x${"00".repeat(32)}`, key]) // no implementation (amendment 3)
const destination = getAddress(`0x${bytesToHex(crypto.getRandomValues(new Uint8Array(20))).slice(2)}`)
const AMOUNT = 10n ** 15n
const accountAbi = parseAbi(['function execute(address to, uint256 value, bytes data)'])

const chain = await startLocalChain({
  root, label: `q1-${label}`, setting: 'written', chainId: 8141, prover: L.PROVER, programs: join(root, 'experiments/19-x14-hash-based-stealth-addresses-under-8288/programs'),
  alloc: { [account]: { balance: '0x8ac7230489e80000', code } }, // 10 ETH
})
console.log(`local chain ${chain.chainId}, ethrex ${chain.ethrexCommit.slice(0, 8)} (${chain.setting}), account ${account} with ${await chain.client.getBalance({ address: account })} wei`)

const skandha = await checkout('skandha', pins.skandha, join(root, 'work'))
await buildSkandha(skandha)
const stamp = Date.now()
const config = join(chain.dir, 'skandha.json')
writeConfig(config, chain.url)
const nodes: Node[] = []
const rows: Record<string, unknown>[] = []
try {
  const a = await startNode({ dir: skandha, name: 'A', config, dataDir: join(chain.dir, `a-${stamp}`), apiPort: 15337, wsPort: 15437, p2pPort: 15000, log: join(chain.dir, 'a.frames.jsonl'), out: join(chain.dir, 'a.out'), handoff: true })
  nodes.push(a)
  const b = await startNode({ dir: skandha, name: 'B', config, dataDir: join(chain.dir, `b-${stamp}`), apiPort: 15338, wsPort: 15438, p2pPort: 15001, log: join(chain.dir, 'b.frames.jsonl'), out: join(chain.dir, 'b.out'), bootEnr: a.enr, handoff: true })
  nodes.push(b)
  await until('nodes A and B to peer', async () => {
    const [pa, pb] = await Promise.all([peersOf(a), peersOf(b)])
    return pa.includes(b.peerId) && pb.includes(a.peerId) ? true : undefined
  }, 120_000)

  // ---- the transfer ----

  const nonce = await getNonceSeq(chain.client, account, [0n])
  const zero = `0x${'00'.repeat(32)}` as Hex
  const tx: FrameTx = {
    chainId: chain.chainId, nonceKeys: [0n], nonceSeq: nonce, sender: account,
    frames: [
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, execution: 30_000n, state: 0n }),
      X14.depFrame(X14.triple(X14.LEANSPHINCS_SCHEME, zero, key)),
      senderFrame({ target: account, data: encodeFunctionData({ abi: accountAbi, functionName: 'execute', args: [destination, AMOUNT, '0x'] }), execution: 60_000n, state: NEW_ACCOUNT_STATE_GAS }),
    ],
    signatures: [], fees: X14.FEES, blobVersionedHashes: [],
  }
  const sighash = frameSigHash(tx)
  const signed = L.sign(seed, Buffer.from(sighash.slice(2), 'hex'))
  if (!signed.verified) throw new Error('the prover refuses its own signature')
  const witness = chain.putSphincsWitness(0x10, sighash, key, { publicKey: signed.publicKey, signature: signed.signature, message: signed.message })
  const sim = await simulateFrameTx(chain.client, tx)
  const simRow = { valid: sim.valid, violation: sim.violation, executionStatus: sim.executionStatus, gasUsed: sim.gasUsed }
  console.log(`simulation: ${JSON.stringify(simRow)}`)
  const raw = serializeFrameTx(tx)
  const hash = frameTxHash(tx)
  const res = await fetch(rpcUrlOf(a), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }) })
  const body = (await res.json()) as { result?: string; error?: unknown }
  const answer = body.error ? `refused: ${JSON.stringify(body.error).slice(0, 400)}` : `admitted: ${body.result}`
  console.log(`node A: ${answer}`)
  // Amendment 2: skandha cannot carry a dependency frame, so a refused transaction goes on to the
  // local ethrex's own pool, and both answers are recorded.
  let direct: string | null = null
  if (!answer.startsWith('admitted')) {
    try { await chain.client.request({ method: 'eth_sendRawTransaction', params: [raw] } as never); direct = 'admitted' } catch (e) { direct = `refused: ${String((e as { details?: string }).details ?? (e as Error).message).slice(0, 300)}` }
    console.log(`the local ethrex's own pool: ${direct}`)
  }
  const r = await waitForFrameTxReceipt(chain.client, hash, { timeoutMs: 180_000 }).catch(() => undefined)
  const frames = r ? r.frameReceipts.map((f) => ({ status: frameReceiptStatus(f), ...frameReceiptGas(f) })) : []
  const block = r ? await chain.client.getBlock({ blockNumber: BigInt(r.blockNumber), includeTransactions: true }) : undefined
  const signaturesInBlock = block ? (block.transactions as unknown as { type: string; signatures?: unknown[] }[]).map((t) => ({ type: t.type, signatures: (t.signatures ?? []).length })) : []
  rows.push({
    step: 'a genesis-funded leanSPHINCS account pays a fresh address', outcome: r ? (frames.every((f) => f.status === 1) ? 'mined' : 'mined, a frame failed') : 'not mined in 180 s',
    hash, block: r ? Number(BigInt(r.blockNumber)) : null, gasUsed: r ? Number(BigInt(r.gasUsed)) : null,
    frames: frames.map((f) => ({ status: f.status, execution: Number(f.execution), state: Number(f.state) })),
    simulation: simRow, nodeA: answer, direct, seen: { A: linesNaming(a.log, hash).slice(0, 6), B: linesNaming(b.log, hash).slice(0, 6) },
    witness, signMs: signed.signMs, signatureBytes: (signed.signature.length - 2) / 2, blockTransactions: signaturesInBlock,
    destinationBalance: (await chain.client.getBalance({ address: destination })).toString(),
  })
  console.log(`transfer: ${rows[0].outcome}${r ? ` block ${rows[0].block} gasUsed ${rows[0].gasUsed} frames ${(rows[0].frames as { status: number; execution: number; state: number }[]).map((f) => `${f.status}:${f.execution}+${f.state}s`).join(' / ')}` : ''}`)
} finally {
  for (const n of nodes) await stopNode(n.child)
}
const builds = chain.builds()
const checks = chain.checks()
await chain.stop()

const record = {
  experiment: 22, run: label, date: new Date().toISOString(), repoCommit, pins,
  command: `npx tsx ${DIR}/smoke.ts ${label}`,
  chain: { chainId: Number(chain.chainId), ethrex: chain.ethrexCommit, patch: 'experiments/19-x14-hash-based-stealth-addresses-under-8288/ethrex-8288.patch', setting: chain.setting },
  account, key, destination, amount: AMOUNT.toString(), rows, builds, checks,
}
let text = JSON.stringify(record, null, 2)
for (const s of secrets) if (text.toLowerCase().includes(s.slice(2).toLowerCase())) throw new Error('a secret would be recorded')
text += '\n'
writeFileSync(join(here, 'results', `${label}.json`), text)
console.log(`recorded results/${label}.json`)
process.exit(0)
