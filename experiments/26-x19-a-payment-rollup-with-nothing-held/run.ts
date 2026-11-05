// Experiment 26 (X19): the runs on the local chain, EIP-8288 extended (README, amendments 1 and 2).
// Part 1: blocks without a signing round, the queue, and three bad blocks, with channel 0's sealed
// backup after each of its changes. Part 3: channel 0's member keeps only its seed and recovers from
// L1. Part 4: the exit as jobs, sent by a taker, to a recipient that holds no ETH. Part 5: every
// block scanned for a classical signature. Part 2's fold is not built yet: one transfer a block.
//
// usage: npx tsx experiments/26-x19-a-payment-rollup-with-nothing-held/run.ts <n>-<label>
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Address, type Hex, bytesToHex, hexToBytes, keccak256 } from 'viem'
import { run, startLocalChain } from '../../src/e2e/index.js'
import { type FrameTx, frameReceiptGas, frameReceiptStatus, frameTxHash, getFrameTxJson, serializeFrameTx, simulateFrameTx, waitForFrameTxReceipt } from '../../src/exp-frames/frametx/index.js'
import { scanBlocks } from '../22-q1-leansphincs-senders/scan.js'
import * as L from '../19-x14-hash-based-stealth-addresses-under-8288/lean.js'
import * as R from './rollup.js'
import * as X from './x19.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const DIR = 'experiments/26-x19-a-payment-rollup-with-nothing-held'
const label = process.argv[2]
if (!label || !/^\d+-[a-z0-9-]+$/.test(label)) throw new Error('usage: run.ts <n>-<label>')
delete process.env.PRIVATE_KEY
const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
const dirty = (await run('git', ['status', '--porcelain', '--', DIR, 'src', 'docs'], { cwd: root })).trim()
if (dirty) throw new Error(`commit the experiment before a recorded run:\n${dirty}`)
const work = join(root, 'work', `x19-${label}`)
mkdirSync(join(work, 'proofs'), { recursive: true })

// ---- the program directory: experiment 19's programs and the user's program ----

const programs = join(work, 'programs')
mkdirSync(programs, { recursive: true })
const x19programs = join(root, 'experiments/19-x14-hash-based-stealth-addresses-under-8288/programs')
for (const f of readdirSync(x19programs)) copyFileSync(join(x19programs, f), join(programs, f))
const prog = X.writeProgram(programs)
console.log(`program ${prog.key}`)

// ---- two channels of two members, registered and funded at genesis (amendment 2) ----

const RECIPIENTS: Address[] = ['0x00000000000000000000000000000000000019a0', '0x00000000000000000000000000000000000019a1']
const BALANCE = 5n * 10n ** 18n
const heads: R.Head[] = [0, 1].map((chan) => {
  const members = [0, 1].map(() => { const seed = crypto.getRandomValues(new Uint8Array(32)); return { seed, key: bytesToHex(L.sphincsKey(seed)) as Hex } }) as [R.Member, R.Member]
  return { chan, balance: BALANCE, salt: R.randomWord(), members, recipient: RECIPIENTS[chan] }
})
const tree = new R.Tree(heads.map(R.leafOf))
const storage: Record<string, Hex> = { [R.word(0)]: tree.root() }
for (const h of heads) storage[R.mapslot(R.word(h.chan), 9)] = R.khOf(h.members[0].key, h.members[1].key, h.recipient)
const ROLLUP_FUNDS = 2n * BALANCE + 10n ** 18n
const chain = await startLocalChain({
  root, label: `x19-${label}`, setting: 'extended', chainId: 8141, prover: L.PROVER, programs,
  alloc: { [R.ROLLUP]: { balance: `0x${ROLLUP_FUNDS.toString(16)}`, code: R.runtimeCode(prog.key), storage } },
})
const client = chain.client
console.log(`local chain ${chain.chainId}, ethrex ${chain.ethrexCommit.slice(0, 8)} (${chain.setting})`)

type Json = Record<string, unknown>
const rows: Json[] = []
const handedLog: Json[] = []
const proofs: Json[] = []
const blockCount = async () => BigInt(await client.readContract({ address: R.ROLLUP, abi: [{ type: 'function', name: 'blockCount', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }], functionName: 'blockCount' }))
const onChainRoot = async () => (await client.readContract({ address: R.ROLLUP, abi: [{ type: 'function', name: 'root', inputs: [], outputs: [{ type: 'bytes32' }], stateMutability: 'view' }], functionName: 'root' })) as Hex

/** Simulate, send to ethrex's own pool, and wait; a refusal is recorded, and thrown only if `expect` says mined. */
async function send(step: string, t: FrameTx, expect: 'mined' | 'refused', extra: Json = {}) {
  const sim = await simulateFrameTx(client, t).catch((e) => ({ valid: false, violation: (e as Error).message.slice(0, 300), executionStatus: null, gasUsed: null }))
  const raw = serializeFrameTx(t)
  const hash = frameTxHash(t)
  const res = await fetch(chain.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }) })
  const body = (await res.json()) as { result?: string; error?: { message?: string } }
  const pool = body.error ? `refused: ${(body.error.message ?? JSON.stringify(body.error)).slice(0, 300)}` : `admitted: ${body.result}`
  const r = body.error ? undefined : await waitForFrameTxReceipt(client, hash, { timeoutMs: 120_000 }).catch(() => undefined)
  const frames = r ? r.frameReceipts.map((f) => ({ status: frameReceiptStatus(f), ...frameReceiptGas(f) })) : []
  const row = {
    step, expect, hash, bytes: (raw.length - 2) / 2, simulation: { valid: sim.valid, violation: sim.violation, executionStatus: sim.executionStatus }, pool,
    outcome: r ? (frames.every((f) => f.status === 1) ? 'mined' : 'mined, a frame failed') : 'not mined',
    block: r ? Number(BigInt(r.blockNumber)) : null, gasUsed: r ? Number(BigInt(r.gasUsed)) : null,
    frames: frames.map((f) => ({ status: f.status, execution: Number(f.execution), state: Number(f.state) })),
    signatures: t.signatures.length, ...extra,
  }
  rows.push(row)
  console.log(`${step}: ${row.outcome}${r ? ` block ${row.block} gas ${row.gasUsed}` : ` (${pool.slice(0, 120)})`}`)
  if (expect === 'mined' && row.outcome !== 'mined') throw new Error(`${step}: expected mined, got ${row.outcome}: ${pool} ${JSON.stringify(row.simulation)}`)
  return row
}

const FEE = 10n ** 9n
let proofN = 0
/** A member makes a transfer; it returns what the member hands an aggregator, and keeps its new head. */
async function member(chan: number, to: number, amount: bigint, o: { expiry?: bigint; signer?: (m: Uint8Array, i: number) => L.Signed; nullifier?: Hex } = {}) {
  const h = heads[chan]
  const expiry = o.expiry ?? (await blockCount()) + 64n
  const made = R.makeTransfer(h, { to, amount, fee: FEE, expiry, program: prog.path, proofFile: join(work, 'proofs', `p${proofN++}.bin`), signer: o.signer, nullifier: o.nullifier })
  proofs.push({ chan, to, amount: amount.toString(), ...made.handed.proved })
  // The aggregator's inputs, as recorded for prediction 3; the head stays on the device.
  handedLog.push({ chan, to, c0: made.handed.c0, c1: made.handed.c1, amountCommit: made.handed.amountCommit, fee: FEE.toString(), expiry: made.handed.expiry.toString(), nullifier: made.handed.nullifier, T: made.handed.T, D: made.handed.D, proofFile: made.handed.proofFile.split('/').pop() })
  return made
}
/** The device adopts its new head once the block holding the transfer is mined, and the public tree moves. */
function adopt(made: ReturnType<typeof R.makeTransfer>) {
  heads[made.handed.chan] = made.next
  tree.leaves[made.handed.chan] = made.newLeaf
}
async function aggregate(step: string, made: ReturnType<typeof R.makeTransfer>, feeTo: Address, expect: 'mined' | 'refused' = 'mined', o: { key1?: Hex; stalePath?: Hex[] } = {}) {
  R.putWitnesses(chain, made.handed, prog.key)
  const t = R.applyTx(chain.chainId, made.handed, o.stalePath ?? tree.path(made.handed.chan), feeTo, prog.key, { key1: o.key1 })
  const row = await send(step, t, expect, { kind: 'apply', chan: made.handed.chan, maxCost: R.maxCostOf(t).toString(), blockCountBefore: Number(await blockCount()) })
  if (row.outcome === 'mined') adopt(made)
  return row
}

const backups: Json[] = []
/** Channel 0's member seals the channel's head to its own key and posts it, signed, in calldata. */
async function backup(step: string, chan: number) {
  const h = heads[chan]
  const sealed = R.sealBackup(h.members[0].seed, h)
  const V = R.backupMessage(sealed)
  chain.putSphincsWitness(0x10, V, h.members[0].key, L.sign(h.members[0].seed, hexToBytes(V)))
  const row = await send(step, R.backupTx(chain.chainId, h, 0, sealed, await blockCount()), 'mined', { kind: 'backup', chan })
  backups.push({ chan, bytes: (sealed.length - 2) / 2, hash: V, block: row.block })
}
const rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
  const res = await fetch(chain.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return ((await res.json()) as { result: T }).result
}
type Log = { topics: Hex[]; data: Hex; transactionHash: Hex; blockNumber: Hex }
const logsOf = (topic: Hex, chan?: number) => rpc<Log[]>('eth_getLogs', [{ address: R.ROLLUP, fromBlock: '0x0', toBlock: 'latest', topics: chan === undefined ? [topic] : [topic, R.word(chan)] }])
let recovery: Json = {}
let exit: Json = {}

const AGG_A = '0x00000000000000000000000000000000000019aa' as Address
const AGG_B = '0x00000000000000000000000000000000000019bb' as Address
let failure: string | null = null
try {
  // ---- part 1: blocks without a signing round ----
  await aggregate('A: channel 0 pays channel 1', await member(0, 1, 10n ** 17n), AGG_A)
  await backup('channel 0 backs up its head', 0)
  await aggregate('A: channel 1 pays channel 0', await member(1, 0, 3n * 10n ** 16n), AGG_A)

  // B refuses channel 0's next leaf; the member queues it.
  const refused = await member(0, 1, 2n * 10n ** 17n)
  R.putSignatures(chain, refused.handed)
  await send('channel 0 queues the leaf B refused', R.queueTx(chain.chainId, refused.handed), 'mined', { kind: 'queue', chan: 0, queuedAtBlockCount: Number(await blockCount()) })
  const queuedAt = await blockCount()

  // A keeps posting channel 1's transfers; after K blocks, a block that omits the queued leaf is refused.
  for (let i = 0; i < R.K; i++) await aggregate(`A: channel 1's transfer ${i + 1}, queued leaf ${Number((await blockCount()) - queuedAt)} blocks old`, await member(1, 0, 10n ** 15n), AGG_A)
  const omitted = await member(1, 0, 10n ** 15n)
  await aggregate(`A: channel 1's transfer, omitting the queued leaf after ${R.K} blocks`, omitted, AGG_A, 'refused')
  await aggregate('A: the queued leaf', refused, AGG_A)
  await backup('channel 0 backs up its head again', 0)

  // Three bad blocks, each refused: a key not the channel's, a reused nullifier, an expired leaf.
  const other = crypto.getRandomValues(new Uint8Array(32))
  const forged = await member(0, 1, 10n ** 15n, { signer: (m, i) => (i === 1 ? L.sign(other, m) : L.sign(heads[0].members[0].seed, m)) })
  await aggregate('bad: member 1\'s triple names a key that is not the channel\'s', forged, AGG_A, 'refused', { key1: bytesToHex(L.sphincsKey(other)) as Hex })
  const first = rows.find((r) => r.step === 'A: channel 0 pays channel 1')
  const reuse = await member(0, 1, 10n ** 15n, { nullifier: handedLog[0].nullifier as Hex })
  await aggregate('bad: a nullifier already used', reuse, AGG_A, 'refused')
  const expired = await member(0, 1, 10n ** 15n, { expiry: (await blockCount()) - 1n })
  await aggregate('bad: a leaf past its expiry', expired, AGG_A, 'refused')
  console.log(`root matches the public tree: ${(await onChainRoot()) === tree.root()}, first block ${first?.block}`)

  // ---- part 3: channel 0's member keeps only its seed, and recovers from L1 ----
  const deleted = heads[0]
  const seed0 = deleted.members[0].seed
  const found = (await logsOf(R.TOPIC.Backup as Hex, 0)).sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)))
  const last = found[found.length - 1]
  const j = await getFrameTxJson(client, last.transactionHash)
  const senderData = (j?.frames ?? [])[2]?.data as Hex | undefined
  const sealed = senderData ? (`0x${senderData.slice(2 + 2 * 0xa4, 2 + 2 * (0xa4 + R.BACKUP_BYTES))}` as Hex) : null
  const opened = sealed ? R.openBackup(seed0, sealed) : null
  const otherOpens = sealed ? R.openBackup(heads[1].members[0].seed, sealed) !== null : null
  const transfers = await logsOf(R.TOPIC.Transfer as Hex)
  const leaves: Hex[] = []
  for (const l of transfers) leaves[Number(BigInt(l.topics[1]))] = `0x${l.data.slice(2 + 128, 2 + 192)}` as Hex
  const rebuilt = new R.Tree(leaves)
  const identical = !!opened && opened.chan === deleted.chan && opened.balance === deleted.balance && opened.salt === deleted.salt &&
    opened.recipient.toLowerCase() === deleted.recipient.toLowerCase() && opened.key0 === deleted.members[0].key && opened.key1 === deleted.members[1].key
  recovery = {
    backupsFound: found.length, backupBytes: backups.map((b) => b.bytes), sameSize: new Set(backups.map((b) => b.bytes)).size === 1,
    opened: !!opened, identical, anotherSeedOpensIt: otherOpens, treeFromLogsMatchesRoot: rebuilt.root() === (await onChainRoot()),
  }
  console.log(`recovery: ${JSON.stringify(recovery)}`)
  if (!opened || !identical) throw new Error('recovery did not rebuild the head')
  // From here on, the device holds only what it recovered.
  const recovered: R.Head = { chan: opened.chan, balance: opened.balance, salt: opened.salt, recipient: opened.recipient, members: [{ seed: seed0, key: opened.key0 }, { seed: new Uint8Array(32), key: opened.key1 }] }

  // ---- part 4: the exit as jobs, sent by a taker, to a recipient holding no ETH ----
  const TAKER = '0x00000000000000000000000000000000000019cc' as Address
  const before = { recipientBalance: (await client.getBalance({ address: recovered.recipient })).toString(), recipientNonce: await client.getTransactionCount({ address: recovered.recipient }) }
  const F = R.freezeMessage(recovered.chan)
  chain.putSphincsWitness(0x10, F, recovered.members[0].key, L.sign(seed0, hexToBytes(F)))
  await send('taker: the freeze, signed by one member', R.freezeTx(chain.chainId, recovered, 0), 'mined', { kind: 'freeze', chan: 0 })
  const after1 = await member(0, 1, 10n ** 15n)
  await aggregate('bad: a transfer from the frozen channel', after1, AGG_A, 'refused')
  const TAKER_FEE = 10n ** 15n
  const C = R.claimMessage(recovered.chan, TAKER, TAKER_FEE)
  chain.putSphincsWitness(0x10, C, recovered.members[0].key, L.sign(seed0, hexToBytes(C)))
  const claim = R.claimTx(chain.chainId, recovered, 0, TAKER, TAKER_FEE, rebuilt.path(recovered.chan))
  const claimRow = await send('taker: the claim, released by the rollup\'s own transaction', claim, 'mined', { kind: 'claim', chan: 0, maxCost: R.maxCostOf(claim).toString() })
  const afterBal = await client.getBalance({ address: recovered.recipient })
  exit = {
    recipient: recovered.recipient, before, after: { recipientBalance: afterBal.toString(), recipientNonce: await client.getTransactionCount({ address: recovered.recipient }), takerBalance: (await client.getBalance({ address: TAKER })).toString() },
    channelBalance: recovered.balance.toString(), takerFee: TAKER_FEE.toString(), claimBlock: claimRow.block,
    recipientSentNothing: (await client.getTransactionCount({ address: recovered.recipient })) === 0,
  }
  console.log(`exit: ${JSON.stringify(exit)}`)
} catch (e) {
  failure = (e as Error).message.slice(0, 600)
  console.log(`stopped: ${failure}`)
} finally {
  await new Promise((r) => setTimeout(r, 15_000))
  const scan = await scanBlocks(client, chain.witnesses).catch((e) => ({ error: (e as Error).message.slice(0, 200) }))
  const builds = chain.builds()
  const checks = chain.checks()
  const rootNow = await onChainRoot().catch(() => null)
  await chain.stop()
  // Prediction 3: no input an aggregator received holds a balance or a salt.
  const secrets = heads.flatMap((h) => [h.salt, X.B(h.balance)]).map((s) => s.toLowerCase().slice(2))
  const handedText = JSON.stringify(handedLog).toLowerCase()
  const leaked = secrets.filter((s) => handedText.includes(s))
  const record = {
    experiment: 26, run: label, date: new Date().toISOString(), repoCommit, command: `npx tsx ${DIR}/run.ts ${label}`,
    chain: { chainId: Number(chain.chainId), ethrex: chain.ethrexCommit, setting: chain.setting, maxVerifyGas: chain.maxVerifyGas },
    program: { file: 'x19_transfer.py', key: prog.key }, rollup: R.ROLLUP, k: R.K, fee: FEE.toString(), limits: Object.fromEntries(Object.entries(R.LIMITS).map(([k, v]) => [k, Number(v)])),
    rows, proofs, handed: handedLog, prediction3: { secretsChecked: secrets.length, leaked: leaked.length }, backups, recovery, exit,
    scan: { blocks: (scan as { blocks?: number }).blocks ?? null, classical: (scan as { classical?: unknown[] }).classical ?? null, error: (scan as { error?: string }).error ?? null },
    rootMatchesTree: rootNow === tree.root(), builds, checks, failure,
  }
  mkdirSync(join(here, 'results'), { recursive: true })
  const out = join(here, 'results', `${label}.json`)
  const text = JSON.stringify(record, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
  for (const h of heads) for (const m of h.members) if (text.includes(bytesToHex(m.seed).slice(2))) throw new Error('a seed would reach the record')
  writeFileSync(out, `${text}\n`)
  console.log(`recorded ${out}; ${rows.length} transactions, prediction 3 leaked ${leaked.length}`)
}
process.exit(0)
