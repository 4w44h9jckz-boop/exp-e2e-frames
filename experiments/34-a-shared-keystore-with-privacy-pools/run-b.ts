// Experiment 34, run: arm B, notes a keystore identity owns, on a locally modified Privacy Pools
// pool beside the unmodified one, on experiment 33's chain. Cases (g0) to (j), as arm B's addendum
// in the README fixes them.
//
// usage: npx tsx experiments/34-a-shared-keystore-with-privacy-pools/run-b.ts <label>
//
// Writes results/<label>.json. Seeds come from public labels and the chain's payer is ethrex's first
// published dev key, so the record holds no secret worth keeping. Needs work/x34-circuits and
// work/x34-circuits-b (circuits.sh, without and with circuit-b.patch), work/pp-deps and
// work/privacy-pools-core at c312dcd.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { keccak_256 } from '@noble/hashes/sha3'
import {
  type Abi, type Address, type Hex, bytesToHex, concatHex, createWalletClient, decodeEventLog, defineChain, encodeAbiParameters, encodeDeployData, encodeFunctionData, encodePacked, http, keccak256, pad,
  parseAbi, toHex,
} from 'viem'
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts'
import { compileYul } from '../../src/exp-frames/contracts.js'
import { create2Address } from '../../src/exp-frames/deploy.js'
import {
  Approve, CREATE2_DEPLOYER, type Frame, type FrameTx, RECENT_ROOT, STORAGE_SET_STATE_GAS, frameReceiptGas, frameReceiptStatus, frameTxHash, getNonceSeq, senderFrame,
  serializeFrameTx, simulateFrameTx, verifyFrame, waitForFrameTxReceipt,
} from '../../src/exp-frames/frametx/index.js'
import { type LocalChain, startLocalChain } from '../../src/e2e/localchain.js'
import { Keystore, accountOf } from '../32-a-shared-keystore-for-stealth-accounts-in-leanvm/keystore.js'
import { PROVER, assemble as assemble32, fromLabel, prove } from '../32-a-shared-keystore-for-stealth-accounts-in-leanvm/x32.js'
import {
  type Identity4, LeanIMT, P, WORK, assemble, compilePool, compilePoolB, contextOf, genesisCode, groth16, halvesOf, hx, link, mainRuleInput, ownScopedInput, ownerTagOf, poseidon,
  register4Input,
} from './x34.js'

const label = process.argv[2]
if (!label) throw new Error('usage: run-b.ts <label>')
const here = new URL('.', import.meta.url).pathname
const root = join(here, '../..')
const work = join(root, 'work')
const out = join(here, 'results', `${label}.json`)
const proofs = join(work, `x34b-proofs-${label}`)
mkdirSync(proofs, { recursive: true })
mkdirSync(join(here, 'results'), { recursive: true })
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim()
const record: Record<string, unknown> = { experiment: 34, arm: 'B', label, commit, date: new Date().toISOString() }
const rows: Record<string, unknown>[] = []
record.rows = rows
const save = () => writeFileSync(out, `${JSON.stringify(record, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 1)}\n`)

// ---- programs, contracts, constants ----

const programs = { register4: assemble('register4'), main4: assemble('main4'), own_main: assemble('own_main'), own_scoped: assemble('own_scoped') }
const rotate32 = assemble32('rotate')
record.programs = Object.fromEntries(Object.entries(programs).map(([k, v]) => [k, v.key]))
const KEYSTORE_CODE = compileYul(join(here, '../33-a-shared-keystore-for-stealth-accounts-on-the-local-chain/contracts/Keystore.yul'))
const ACCOUNT5_CODE = compileYul(join(here, 'contracts/Account5.yul'))
const OWNER_CHECK_CODE = compileYul(join(here, 'contracts/OwnerCheck.yul'))
const OPEN_SENDER_CODE = compileYul(join(here, 'contracts/OpenSender.yul'))
const GAS_PROBE_CODE = compileYul(join(here, 'contracts/GasProbe.yul'))
const RECENT_ROOT_CODE = `0x${readFileSync(join(work, 'ethrex/scripts/hegota-testnet/recent_root/main.hex'), 'utf8').trim()}` as Hex
const DOMAIN_B = keccak256(toHex('exp-e2e-frames/34/owner'))
const DOMAIN_5 = keccak256(toHex('exp-e2e-frames/34/execute'))
const FEES = { maxPriorityFeePerGas: 1n, maxFeePerGas: 100n, maxFeePerBlobGas: 0n }
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as Address
const PAYMENT = 10n ** 16n
const word = (x: bigint): Hex => pad(toHex(x), { size: 32 })
const sha = (h: Hex) => bytesToHex(keccak_256(Buffer.from(h.slice(2), 'hex'))).slice(0, 14)
const seed = (l: string) => fromLabel(`x34/b/${l}`)
const keyOf = (l: string): Hex => bytesToHex(seed(`key/${l}`))
const account5Abi = parseAbi(['function execute(address target, uint256 value, bytes data)'])
const poolA = compilePool()
const poolB = compilePoolB()
const CIRC_A = join(WORK, 'x34-circuits')
const CIRC_B = join(WORK, 'x34-circuits-b')
const constraints = (dir: string) => Number(/# of Constraints: (\d+)/.exec(readFileSync(join(dir, 'withdraw.info.txt'), 'utf8').replace(/\x1b\[[0-9;]*m/g, ''))![1])
record.circuits = { withdrawA: constraints(CIRC_A), withdrawB: constraints(CIRC_B) }
console.log(`withdrawal circuit: ${constraints(CIRC_A)} constraints unmodified, ${constraints(CIRC_B)} modified`)

// ---- the chain ----

const devKey = readFileSync(join(work, 'ethrex/fixtures/keys/private_keys_l1.txt'), 'utf8').split('\n')[0].trim() as Hex
const dev = privateKeyToAddress(devKey)
const skipFile = join(work, `x34b-skip-${label}`)
writeFileSync(skipFile, '0')
process.env.X33_SLOT_SKIP_FILE = skipFile
const binary = join(work, 'ethrex-bins/ethrex-8288-clock')
// As in arm A (its deviation 1): the Poseidon libraries and both Entrypoints' implementations are in
// the genesis, as the code a CREATE at these addresses would leave.
const T3 = '0x0000000000000000000000000000000000034003' as Address
const T4 = '0x0000000000000000000000000000000000034004' as Address
const EP_IMPL_A = '0x00000000000000000000000000000000000340e1' as Address
const EP_IMPL_B = '0x00000000000000000000000000000000000340e2' as Address
const genesisAlloc = {
  [RECENT_ROOT.toLowerCase()]: { balance: '0x0', code: RECENT_ROOT_CODE, nonce: '0x1' },
  [T3]: { balance: '0x0', code: genesisCode(poolA.PoseidonT3, T3), nonce: '0x1' },
  [T4]: { balance: '0x0', code: genesisCode(poolA.PoseidonT4, T4), nonce: '0x1' },
  [EP_IMPL_A]: { balance: '0x0', code: genesisCode(poolA.Entrypoint, EP_IMPL_A), nonce: '0x1' },
  [EP_IMPL_B]: { balance: '0x0', code: genesisCode(poolB.Entrypoint, EP_IMPL_B), nonce: '0x1' },
}
const chain: LocalChain = await startLocalChain({
  root, label: `x34b-${label}`, setting: 'extended', prover: PROVER, programs: join(here, 'build'),
  alloc: genesisAlloc, chainId: 8141, binary, maxVerifyGas: 500_000,
})
const client = chain.client
process.on('uncaughtException', (e) => { console.error(e); void chain.stop().finally(() => process.exit(1)) })
const local = defineChain({ id: Number(chain.chainId), name: 'x34 local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [chain.url] } } })
const walletOf = (k: Hex) => createWalletClient({ account: privateKeyToAccount(k), chain: local, transport: http(chain.url) })
record.chain = { ethrex: chain.ethrexCommit, binary: 'ethrex-8288-clock', maxVerifyGas: 500_000, predeploy: sha(RECENT_ROOT_CODE) }
console.log(`chain ${chain.chainId}, ethrex ${chain.ethrexCommit.slice(0, 8)}`)
for (const [name, a] of [['PoseidonT3', T3], ['PoseidonT4', T4], ['Entrypoint implementation A', EP_IMPL_A], ['Entrypoint implementation B', EP_IMPL_B]] as const) {
  const code = await client.getCode({ address: a })
  if (!code || code === '0x') throw new Error(`genesis ${name}: no code at ${a}`)
}

async function block(n?: bigint) {
  const b = await client.request({ method: 'eth_getBlockByNumber', params: [n === undefined ? 'latest' : toHex(n), false] } as never) as Record<string, Hex>
  return { number: BigInt(b.number), slot: b.slotNumber !== undefined ? BigInt(b.slotNumber) : undefined }
}
async function eoa(step: string, key: Hex, req: { to?: Address; data?: Hex; value?: bigint; gas: bigint }, refusable = false) {
  const hash = await walletOf(key).sendTransaction({ ...req, maxFeePerGas: 10n ** 10n, maxPriorityFeePerGas: 1n } as never)
  const r = await client.waitForTransactionReceipt({ hash, timeout: 180_000 })
  const b = await block(r.blockNumber)
  const row = { step, hash, block: Number(r.blockNumber), slot: b.slot, status: r.status, gasUsed: Number(r.gasUsed), effectiveGasPrice: r.effectiveGasPrice, contract: r.contractAddress, logs: r.logs }
  console.log(`${step}: ${r.status} gas ${r.gasUsed} block ${r.blockNumber}`)
  rows.push({ ...row, logs: r.logs.length })
  if (r.status !== 'success' && !refusable) throw new Error(`${step}: ${r.status}`)
  return row
}
async function deploy(step: string, abi: Abi, bytecode: Hex, args: unknown[] = []) {
  const data = encodeDeployData({ abi, bytecode, args } as never)
  const row = await eoa(step, devKey, { data, gas: 24_000_000n }, true)
  if (row.status !== 'success') {
    // Replay the creation against the parent block to report why it reverted.
    const from = privateKeyToAccount(devKey).address
    const res = await fetch(chain.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ from, data, gas: '0x' + (24_000_000).toString(16) }, '0x' + (row.block - 1).toString(16)] }) })
    const why = JSON.stringify(await res.json())
    throw new Error(`${step}: ${row.status}: ${why}`)
  }
  return row.contract as Address
}
async function call(to: Address, abi: Abi, functionName: string, args: unknown[] = []) {
  const r = await client.readContract({ address: to, abi, functionName, args } as never)
  return r as unknown
}

/** Simulate, then send; a refusal is recorded, and thrown only where it was not expected. */
async function frames(step: string, tx: FrameTx, extra: Record<string, unknown> = {}, refusable = false) {
  const raw = serializeFrameTx(tx)
  const hash = frameTxHash(tx)
  const sim = await simulateFrameTx(client, tx).catch((e) => ({ valid: false, violation: (e as Error).message.slice(0, 300) }))
  let sent: string | undefined
  try { await client.request({ method: 'eth_sendRawTransaction', params: [raw] } as never) } catch (e) { sent = String((e as { details?: string }).details ?? (e as Error).message).slice(0, 400) }
  if (sent) {
    const row = { step, outcome: 'refused by the node', refusal: sent, simulation: sim, ...extra }
    console.log(`${step}: refused: ${sent.slice(0, 200)}`)
    console.log(`  simulation: ${JSON.stringify(sim, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 1200)}`)
    rows.push(row)
    if (!refusable) throw new Error(`${step}: refused: ${sent}`)
    return row
  }
  const r = await waitForFrameTxReceipt(client, hash, { timeoutMs: 240_000 })
  const fr = r.frameReceipts.map((f) => ({ status: frameReceiptStatus(f), ...frameReceiptGas(f), logs: f.logs?.length ?? 0 }))
  const ok = fr.every((f) => f.status === 1)
  const row = { step, outcome: ok ? 'included' : 'included, a frame failed', hash, block: Number(BigInt(r.blockNumber)), gasUsed: Number(BigInt(r.gasUsed)), frames: fr.map((f) => ({ status: f.status, execution: Number(f.execution), state: Number(f.state), logs: f.logs })), receiptLogs: r.frameReceipts.flatMap((f) => f.logs ?? []), ...extra }
  console.log(`${step}: ${row.outcome} block ${row.block} gas ${row.gasUsed} frames ${fr.map((f) => `${f.status}:${f.execution}+${f.state}s`).join(' / ')}`)
  rows.push({ ...row, receiptLogs: undefined, simulation: sim })
  if (!ok && !refusable) throw new Error(`${step}: a frame failed`)
  return row
}
const depFrame = (triple: Hex): Frame => ({ mode: 4, flags: 0, target: null, limits: { execution: 30_000n, state: 0n }, value: 0n, data: triple })
const tripleOf = (d: Hex, vk: Hex): Hex => concatHex([word(0x11n), d, vk])
const rrFrame = (data: Hex): Frame => verifyFrame({ scope: Approve.NONE, target: RECENT_ROOT, data, execution: 20_000n, state: 0n })

// ---- the keystore ----

const ks = new Keystore()
const KS_INIT = concatHex([KEYSTORE_CODE, programs.register4.key, rotate32.key as Hex])
const ksAddr = (await eoa('deploy the keystore', devKey, { data: KS_INIT, gas: 5_000_000n })).contract as Address
const sourceId = keccak256(encodePacked(['address', 'bytes32'], [ksAddr, pad('0x00', { size: 32 })]))
await eoa('fund the keystore', devKey, { to: ksAddr, value: 10n ** 18n, gas: 100_000n })
let last = { slot: 0n, rho: hx(ks.root()) }
async function checkRoot(what: string) {
  const r = (await client.call({ to: ksAddr, data: '0xebf0c717' })).data as Hex
  if (r !== hx(ks.root())) throw new Error(`${what}: the keystore's root ${r} is not the reference's`)
}
async function register(step: string, id: Identity4) {
  const reg = register4Input(id)
  const file = join(proofs, `${step.replace(/\W+/g, '-')}.bin`)
  const p = prove(programs.register4.path, { ...reg.input, proofOut: file })
  if ('error' in p) throw new Error(`${step}: ${p.error}`)
  chain.putStarkWitness(hx(reg.D), programs.register4.key, readFileSync(file))
  const p2 = ks.leaves.path(ks.leaves.size)
  const pathT = p2.kids.map(([l, r], i) => hx(p2.bits[i] ? l : r))
  const data = concatHex(['0xb4016cff', hx(reg.leaf), hx(reg.q), ...pathT])
  const nonce = await getNonceSeq(client, ksAddr, [0n])
  const tx: FrameTx = {
    chainId: chain.chainId, nonceKeys: [0n], nonceSeq: nonce, sender: ksAddr,
    frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, data: '0x', execution: 80_000n, state: 0n }), depFrame(tripleOf(hx(reg.D), programs.register4.key)), senderFrame({ target: ksAddr, data, execution: 800_000n, state: 8n * STORAGE_SET_STATE_GAS })],
    signatures: [], fees: FEES, blobVersionedHashes: [],
  }
  const row = await frames(step, tx, { proof: { cycles: p.cycles, proofBytes: p.proofBytes, proveMs: p.warmupMs } })
  ks.register(reg.leaf, reg.q)
  last = { slot: (await block(BigInt((row as { block: number }).block))).slot!, rho: hx(ks.root()) }
  await checkRoot(step)
}

// ---- the pools ----

const h = await poseidon()
type Compiled = ReturnType<typeof compilePool>
type PoolView = {
  name: 'A' | 'B'; c: Compiled; ep: Address; pool: Address; scope: bigint; circuits: string
  state: LeanIMT; asp: LeanIMT; notes: Map<bigint, { label: bigint; value: bigint; commitment: bigint }>
}
async function setupPool(name: 'A' | 'B', c: Compiled, epImpl: Address, circuits: string, extra: Address[]): Promise<PoolView> {
  const wv = await deploy(`pool ${name}: deploy the withdrawal verifier`, c.WithdrawalVerifier.abi, `0x${c.WithdrawalVerifier.bytecode}`)
  const cv = await deploy(`pool ${name}: deploy the ragequit verifier`, c.CommitmentVerifier.abi, `0x${c.CommitmentVerifier.bytecode}`)
  const init = encodeFunctionData({ abi: c.Entrypoint.abi, functionName: 'initialize', args: [dev, dev] } as never)
  const ep = await deploy(`pool ${name}: deploy the Entrypoint proxy`, c.ERC1967Proxy.abi, `0x${c.ERC1967Proxy.bytecode}`, [epImpl, init])
  const pool = await deploy(`pool ${name}: deploy the native-ETH pool`, c.PrivacyPoolSimple.abi, link(c.PrivacyPoolSimple, { PoseidonT3: T3, PoseidonT4: T4 }), [ep, wv, cv, ...extra])
  await eoa(`pool ${name}: register the pool`, devKey, { to: ep, data: encodeFunctionData({ abi: c.Entrypoint.abi, functionName: 'registerPool', args: [NATIVE, pool, 10n ** 12n, 0n, 100n] } as never), gas: 1_000_000n })
  const scope = (await call(pool, c.PrivacyPoolSimple.abi, 'SCOPE')) as bigint
  return { name, c, ep, pool, scope, circuits, state: new LeanIMT(h), asp: new LeanIMT(h), notes: new Map() }
}
const A = await setupPool('A', poolA, EP_IMPL_A, CIRC_A, [])
const ACCOUNT5_IMPL = (await eoa('deploy the Account5 implementation', devKey, { data: ACCOUNT5_CODE, gas: 3_000_000n })).contract as Address
const programWord = (k: Hex) => k
const OWNER_CHECK = (await eoa('deploy the ownership checker', devKey, { data: concatHex([OWNER_CHECK_CODE, sourceId, programWord(programs.own_main.key), programWord(programs.own_scoped.key), programWord(programs.main4.key), pad(ACCOUNT5_IMPL, { size: 32 })]), gas: 3_000_000n })).contract as Address
const B = await setupPool('B', poolB, EP_IMPL_B, CIRC_B, [OWNER_CHECK])
const OPEN = (await eoa('deploy the open sender', devKey, { data: OPEN_SENDER_CODE, gas: 1_000_000n })).contract as Address
await eoa('fund the open sender', devKey, { to: OPEN, value: 10n ** 18n, gas: 100_000n })
const PROBE = (await eoa('deploy the gas probe', devKey, { data: GAS_PROBE_CODE, gas: 1_000_000n })).contract as Address
record.pools = Object.fromEntries([A, B].map((v) => [v.name, { entrypoint: v.ep, pool: v.pool, scope: v.scope }]))
record.contracts = { account5: { address: ACCOUNT5_IMPL, code: sha(ACCOUNT5_CODE) }, ownerCheck: { address: OWNER_CHECK, code: sha(OWNER_CHECK_CODE) }, openSender: OPEN, gasProbe: PROBE, entrypointImplementations: { A: EP_IMPL_A, B: EP_IMPL_B } }
save()

type Log = { address: Address; topics: Hex[]; data: Hex }
const eventsOf = (v: PoolView, logs: Log[]) => logs.filter((l) => l.address.toLowerCase() === v.pool.toLowerCase())
  .map((l) => { try { return decodeEventLog({ abi: v.c.PrivacyPoolSimple.abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as unknown as { eventName: string; args: Record<string, bigint> } } catch { return undefined } })
async function checkTree(v: PoolView) {
  if ((await call(v.pool, v.c.PrivacyPoolSimple.abi, 'currentRoot')) as bigint !== v.state.root()) throw new Error(`pool ${v.name}: the state tree is not the pool's`)
}
/** A deposit's event: the state tree updated and checked, and the postman admits the label. */
async function observeDeposit(v: PoolView, logs: Log[]) {
  const ev = eventsOf(v, logs).find((e) => e?.eventName === 'Deposited')
  if (!ev) return undefined
  v.state.insert(ev.args._commitment)
  v.notes.set(ev.args._precommitmentHash, { label: ev.args._label, value: ev.args._value, commitment: ev.args._commitment })
  await checkTree(v)
  v.asp.insert(ev.args._label)
  await eoa(`pool ${v.name}: postman admits the deposit`, devKey, { to: v.ep, data: encodeFunctionData({ abi: v.c.Entrypoint.abi, functionName: 'updateRoot', args: [v.asp.root(), 'x34-local-postman-admits-every-deposit-0000000000'] } as never), gas: 3_000_000n })
  return ev.args
}
/** A withdrawal's change note, of value zero here, inserted as the pool inserts it. */
async function observeWithdrawal(v: PoolView, logs: Log[]) {
  const ev = eventsOf(v, logs).find((e) => e?.eventName === 'Withdrawn')
  if (!ev) return undefined
  v.state.insert(ev.args._newCommitment)
  await checkTree(v)
  return ev.args
}

// ---- the identity, its accounts and its notes ----

const Ibound: Identity4 = { s: seed('id/s'), version: 0, main: { rule: 1n, seeds: [seed('id/main')] }, scopeSeed: seed('id/indexer'), list: [], rec: seed('id/rec'), salt: seed('id/salt') }
await register('register the identity', Ibound)
const tuple = () => concatHex([sourceId, pad(toHex(last.slot), { size: 8 }), last.rho])

/** A note: plain, P = Poseidon(n, t); or tagged by the identity's note i, t = Poseidon(T, sigma). */
type Note = { n: bigint; t: bigint; pc: bigint; tag?: { index: number; T: Uint8Array; hi: bigint; lo: bigint; sigma: bigint } }
const fieldOf = (l: string) => BigInt(bytesToHex(seed(l))) % P
function plainNote(l: string): Note { const n = fieldOf(`note/${l}/n`); const t = fieldOf(`note/${l}/t`); return { n, t, pc: h([n, t]) } }
function taggedNote(l: string, index: number): Note {
  const T = ownerTagOf(Ibound.s, index)
  const hv = halvesOf(T)
  const sigma = fieldOf(`note/${l}/sigma`)
  const t = h([(hv.hi * (1n << 128n) + hv.lo) % P, sigma])
  const n = fieldOf(`note/${l}/n`)
  return { n, t, pc: h([n, t]), tag: { index, T, hi: hv.hi, lo: hv.lo, sigma } }
}
async function depositByDev(step: string, v: PoolView, note: Note) {
  const row = await eoa(step, devKey, { to: v.ep, data: encodeFunctionData({ abi: v.c.Entrypoint.abi, functionName: 'deposit', args: [note.pc] } as never), value: PAYMENT, gas: 3_000_000n })
  await observeDeposit(v, row.logs as Log[])
}

/** A withdrawal of the whole note, relayed through the pool's Entrypoint to `recipient` with fee 0. */
async function relayCall(v: PoolView, note: Note, recipient: Address, step: string) {
  const info = v.notes.get(note.pc)
  if (!info) throw new Error(`${step}: no deposit for that precommitment`)
  const data = encodeAbiParameters([{ type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }] }], [[recipient, recipient, 0n]])
  const context = contextOf(v.ep, data, v.scope)
  const sp = v.state.proof(v.state.indexOf(info.commitment))
  const ap = v.asp.proof(v.asp.indexOf(info.label))
  const fresh = { n: fieldOf(`change/${step}/n`), t: fieldOf(`change/${step}/t`) }
  const secret = note.tag ? { ownerTagHi: note.tag.hi, ownerTagLo: note.tag.lo, ownerSalt: note.tag.sigma } : { existingSecret: note.t }
  const g = await groth16('withdraw', {
    withdrawnValue: info.value, stateRoot: sp.root, stateTreeDepth: sp.depth, ASPRoot: ap.root, ASPTreeDepth: ap.depth, context,
    label: info.label, existingValue: info.value, existingNullifier: note.n, ...secret, newNullifier: fresh.n, newSecret: fresh.t,
    stateSiblings: sp.siblings, stateIndex: sp.index, ASPSiblings: ap.siblings, ASPIndex: ap.index,
  }, v.circuits)
  const call_ = encodeFunctionData({ abi: v.c.Entrypoint.abi, functionName: 'relay', args: [{ processooor: v.ep, data }, g.sol, v.scope] } as never)
  return { call: call_, context, g, value: info.value, m: keccak256(concatHex([DOMAIN_B, word(context)])) }
}

/** A transaction from the open sender: the recent-root frame, its VERIFY, then `rest`. */
async function fromOpen(step: string, rest: Frame[], extra: Record<string, unknown> = {}) {
  const nonce = await getNonceSeq(client, OPEN, [0n])
  const tx: FrameTx = {
    chainId: chain.chainId, nonceKeys: [0n], nonceSeq: nonce, sender: OPEN,
    frames: [rrFrame(tuple()), verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, data: '0x', execution: 20_000n, state: 0n }), ...rest],
    signatures: [], fees: FEES, blobVersionedHashes: [],
  }
  return frames(step, tx, extra, true)
}
const relayFrame = (v: PoolView, data: Hex) => senderFrame({ target: v.ep, data, execution: 3_000_000n, state: 10n * STORAGE_SET_STATE_GAS })
const probeFrame = (T: Uint8Array, context: bigint, recipient: Address) => senderFrame({
  target: PROBE, data: concatHex([pad(OWNER_CHECK, { size: 32 }), encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], [hx(T), context, recipient, 0n])]), execution: 200_000n, state: 0n,
})
const probeOf = (row: Record<string, unknown>) => {
  const l = ((row.receiptLogs as Log[]) ?? []).find((x) => x.address.toLowerCase() === PROBE.toLowerCase())
  return l ? { gas: Number(BigInt(`0x${l.data.slice(2, 66)}`)), ok: BigInt(`0x${l.data.slice(66, 130)}`) === 1n } : undefined
}
async function proveDep(step: string, program: 'own_main' | 'own_scoped' | 'main4', input: Parameters<typeof prove>[1], D: Uint8Array) {
  const file = join(proofs, `${step.replace(/\W+/g, '-')}.bin`)
  const p = prove(programs[program].path, { ...input, proofOut: file })
  if ('error' in p) return { error: p.error.slice(0, 240) }
  chain.putStarkWitness(hx(D), programs[program].key, readFileSync(file))
  return { frame: depFrame(tripleOf(hx(D), programs[program].key)), proof: { cycles: p.cycles, proofBytes: p.proofBytes, proveMs: p.warmupMs } }
}
async function balanceRow(step: string, who: Address, before: bigint, extra: Record<string, unknown>) {
  const after = await client.getBalance({ address: who })
  rows[rows.length - 1] = { ...rows[rows.length - 1], ...extra, recipient: who, recipientBefore: before, recipientAfter: after }
  console.log(`  ${step}: recipient ${before} -> ${after}${extra.checker ? `; the checker, probed: ${JSON.stringify(extra.checker)}` : ''}`)
  return after - before
}

const indexer = privateKeyToAddress(keyOf('indexer'))
const outside = privateKeyToAddress(keyOf('outside'))
record.cases = {}
const cases = record.cases as Record<string, unknown>

// (g0) The control: the unmodified pool. The indexer, holding n and t, relays the note to itself.
const g0note = plainNote('g0')
await depositByDev('(g0) a deposit to pool A', A, g0note)
{
  const r = await relayCall(A, g0note, indexer, 'g0')
  const before = await client.getBalance({ address: indexer })
  const row = await fromOpen('(g0) pool A: the indexer relays the note to itself', [relayFrame(A, r.call)], { groth16Ms: r.g.ms, groth16Verified: r.g.ok })
  await observeWithdrawal(A, ((row as Record<string, unknown>).receiptLogs as Log[]) ?? [])
  cases.g0 = { outcome: row.outcome, paid: await balanceRow('(g0)', indexer, before, {}) }
}

// (g1) to (g3) The modified pool: the note is tagged, and the indexer holds n, T, sigma and s.
const gNote = taggedNote('g', 0)
await depositByDev('(g) a tagged deposit to pool B', B, gNote)
{
  const r = await relayCall(B, gNote, indexer, 'g1')
  const before = await client.getBalance({ address: indexer })
  const row = await fromOpen('(g1) pool B: to itself, with no dependency', [probeFrame(gNote.tag!.T, r.context, indexer), relayFrame(B, r.call)], { groth16Ms: r.g.ms })
  const checker = probeOf(row as Record<string, unknown>)
  cases.g1 = { outcome: row.outcome, checker, paid: await balanceRow('(g1)', indexer, before, { checker }) }
}
{
  const r = await relayCall(B, gNote, indexer, 'g2')
  const inp = ownScopedInput(ks, Ibound, seed('g2/rp'), 0, Buffer.from(r.m.slice(2), 'hex'))
  const dep = await proveDep('(g2) own_scoped', 'own_scoped', inp.input, inp.D)
  if ('error' in dep) throw new Error(`(g2): own_scoped refused: ${dep.error}`)
  const before = await client.getBalance({ address: indexer })
  const row = await fromOpen('(g2) pool B: to itself, with an own_scoped proof', [dep.frame, probeFrame(inp.T, r.context, indexer), relayFrame(B, r.call)], { proof: dep.proof })
  const checker = probeOf(row as Record<string, unknown>)
  cases.g2 = { outcome: row.outcome, checker, paid: await balanceRow('(g2)', indexer, before, { checker }) }
}
{
  const r = await relayCall(B, gNote, indexer, 'g3')
  const inp = mainRuleInput(1, ks, Ibound, Buffer.from(r.m.slice(2), 'hex'), { index: 0, signers: [Ibound.scopeSeed] })
  const dep = await proveDep('(g3) own_main with the indexer key', 'own_main', inp.input, inp.D)
  const row = { step: '(g3) pool B: own_main signed with the indexer\'s key', outcome: 'error' in dep ? 'refused by the prover' : 'proved', error: 'error' in dep ? dep.error : undefined }
  console.log(`${row.step}: ${row.outcome}`)
  rows.push(row)
  cases.g3 = { outcome: row.outcome }
}

// (h) The indexer relays to a fresh account of the identity, deployed by a frame of the transaction.
const hNote = taggedNote('h', 1)
await depositByDev('(h) a tagged deposit to pool B', B, hNote)
{
  const rp = seed('h/rp')
  const Cp = hx(accountOf(Ibound.s, rp))
  const initcode = cloneInitcode(ACCOUNT5_IMPL, [Cp, programs.main4.key, sourceId])
  const fresh = create2Address(initcode, Cp)
  const r = await relayCall(B, hNote, fresh, 'h')
  const inp = ownScopedInput(ks, Ibound, rp, 1, Buffer.from(r.m.slice(2), 'hex'))
  const dep = await proveDep('(h) own_scoped', 'own_scoped', inp.input, inp.D)
  if ('error' in dep) throw new Error(`(h): own_scoped refused: ${dep.error}`)
  const deployFrame: Frame = { mode: 0, flags: 0, target: CREATE2_DEPLOYER, limits: { execution: 150_000n, state: 420_000n }, value: 0n, data: concatHex([Cp, initcode]) }
  const before = await client.getBalance({ address: fresh })
  const row = await fromOpen('(h) pool B: to a fresh account of the identity, with own_scoped', [dep.frame, deployFrame, probeFrame(inp.T, r.context, fresh), relayFrame(B, r.call)], { proof: dep.proof, groth16Ms: r.g.ms })
  await observeWithdrawal(B, ((row as Record<string, unknown>).receiptLogs as Log[]) ?? [])
  cases.h = { outcome: row.outcome, account: fresh, checker: probeOf(row as Record<string, unknown>), paid: await balanceRow('(h)', fresh, before, { checker: probeOf(row as Record<string, unknown>) }) }
}

// (i) The owner's main rule signs; the withdrawal goes to an address outside the identity.
const iNote = taggedNote('i', 2)
await depositByDev('(i) a tagged deposit to pool B', B, iNote)
{
  const r = await relayCall(B, iNote, outside, 'i')
  const inp = mainRuleInput(1, ks, Ibound, Buffer.from(r.m.slice(2), 'hex'), { index: 2 })
  const dep = await proveDep('(i) own_main', 'own_main', inp.input, inp.D)
  if ('error' in dep) throw new Error(`(i): own_main refused: ${dep.error}`)
  const before = await client.getBalance({ address: outside })
  const row = await fromOpen('(i) pool B: the owner\'s main rule, to an outside address', [dep.frame, probeFrame(inp.A, r.context, outside), relayFrame(B, r.call)], { proof: dep.proof, groth16Ms: r.g.ms })
  await observeWithdrawal(B, ((row as Record<string, unknown>).receiptLogs as Log[]) ?? [])
  cases.i = { outcome: row.outcome, checker: probeOf(row as Record<string, unknown>), paid: await balanceRow('(i)', outside, before, { checker: probeOf(row as Record<string, unknown>) }) }
}

// (j) An Account5 account deposits into each pool through execute, then ragequits through execute.
/** The account's transaction: execute(target, value, data) under main4, deploying it first if needed. */
async function execute(step: string, rl: Uint8Array, account: Address, Cacct: Hex, initcode: Hex, target: Address, value: bigint, data: Hex) {
  const code = await client.getCode({ address: account })
  const deployFirst = !code || code === '0x'
  const nonce = await getNonceSeq(client, account, [0n])
  const m = keccak256(concatHex([DOMAIN_5, pad(account, { size: 32 }), word(nonce), pad(target, { size: 32 }), word(value), keccak256(data)]))
  const inp = mainRuleInput(0, ks, Ibound, Buffer.from(m.slice(2), 'hex'), { r: rl })
  if (hx(inp.A) !== Cacct) throw new Error(`${step}: the program's account is not the account's`)
  const dep = await proveDep(step, 'main4', inp.input, inp.D)
  if ('error' in dep) throw new Error(`${step}: main4 refused: ${dep.error}`)
  const deployFrame: Frame = { mode: 0, flags: 0, target: CREATE2_DEPLOYER, limits: { execution: 150_000n, state: 300_000n }, value: 0n, data: concatHex([Cacct, initcode]) }
  const tx: FrameTx = {
    chainId: chain.chainId, nonceKeys: [0n], nonceSeq: nonce, sender: account,
    frames: [
      rrFrame(tuple()),
      ...(deployFirst ? [deployFrame] : []),
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, data: '0x', execution: 60_000n, state: 0n }),
      dep.frame,
      senderFrame({ target: account, data: encodeFunctionData({ abi: account5Abi, functionName: 'execute', args: [target, value, data] }), execution: 3_000_000n, state: 10n * STORAGE_SET_STATE_GAS }),
    ],
    signatures: [], fees: FEES, blobVersionedHashes: [],
  }
  return frames(step, tx, { account, deployFirst, proof: dep.proof }, true)
}
cases.j = {}
for (const [v, note] of [[A, plainNote('j/A')], [B, taggedNote('j/B', 3)]] as const) {
  const rl = seed(`j/${v.name}/r`)
  const Cacct = hx(accountOf(Ibound.s, rl))
  const initcode = cloneInitcode(ACCOUNT5_IMPL, [Cacct, programs.main4.key, sourceId])
  const J = create2Address(initcode, Cacct)
  await eoa(`(j) pool ${v.name}: a payment to the account`, devKey, { to: J, value: 2n * PAYMENT, gas: 500_000n })
  const dRow = await execute(`(j) pool ${v.name}: the account deposits through execute`, rl, J, Cacct, initcode, v.ep, PAYMENT, encodeFunctionData({ abi: v.c.Entrypoint.abi, functionName: 'deposit', args: [note.pc] } as never))
  const dep = await observeDeposit(v, ((dRow as Record<string, unknown>).receiptLogs as Log[]) ?? [])
  if (!dep) { (cases.j as Record<string, unknown>)[v.name] = { deposit: dRow.outcome }; continue }
  const info = v.notes.get(note.pc)!
  const g = await groth16('commitment', { value: info.value, label: info.label, nullifier: note.n, secret: note.t }, v.circuits)
  const before = await client.getBalance({ address: J })
  const qRow = await execute(`(j) pool ${v.name}: the account ragequits through execute`, rl, J, Cacct, initcode, v.pool, 0n, encodeFunctionData({ abi: v.c.PrivacyPoolSimple.abi, functionName: 'ragequit', args: [g.sol] } as never))
  const after = await client.getBalance({ address: J })
  rows[rows.length - 1] = { ...rows[rows.length - 1], groth16Ms: g.ms, accountBefore: before, accountAfter: after }
  console.log(`  (j) pool ${v.name}: account ${before} -> ${after}`)
  ;(cases.j as Record<string, unknown>)[v.name] = { deposit: dRow.outcome, ragequit: qRow.outcome, value: info.value, accountBefore: before, accountAfter: after }
}

record.builds = chain.builds().length
record.finished = new Date().toISOString()
save()
await chain.stop()
console.log(`wrote ${out}`)

// EIP-1167's runtime with the account's words appended after it, behind the creation code that
// copies the whole runtime out (as run.ts builds arm A's accounts).
function cloneInitcode(impl: Address, words: Hex[]): Hex {
  const runtime = concatHex(['0x363d3d373d3d3d363d73', impl, '0x5af43d82803e903d91602b57fd5bf3', ...words])
  const n = (runtime.length - 2) / 2
  if (n > 0xff) throw new Error('clone runtime over 255 bytes')
  return concatHex([`0x3d60${n.toString(16).padStart(2, '0')}80600a3d3981f3`, runtime])
}
