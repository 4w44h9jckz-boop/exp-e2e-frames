// Experiment 34, run: arm A, a scoped deposit into Privacy Pools from a keystore account, on
// experiment 33's chain.
//
// usage: npx tsx experiments/34-a-shared-keystore-with-privacy-pools/run.ts <label>
//
// Writes results/<label>.json. Seeds come from public labels and the chain's payer is ethrex's first
// published dev key, so the record holds no secret worth keeping. Needs work/x34-circuits (built by
// circuits.sh), work/pp-deps and work/privacy-pools-core at c312dcd.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { keccak_256 } from '@noble/hashes/sha3'
import {
  type Abi, type Address, type Hex, bytesToHex, concatHex, createWalletClient, decodeEventLog, defineChain, encodeDeployData, encodeFunctionData, encodePacked, http, keccak256, pad,
  decodeErrorResult, parseAbi, toHex,
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
import { type Identity4, LeanIMT, P, assemble, compilePool, contextOf, genesisCode, groth16, hx, link, poseidon, register4Input, scopedInput, word32 } from './x34.js'

const label = process.argv[2]
// 'cases' runs cases (a) to (e), as run 1 did; 'fees' runs the addendum's (f2), (f3a) and (f3b).
const mode = process.argv[3] ?? 'cases'
if (!label || !['cases', 'fees'].includes(mode)) throw new Error('usage: run.ts <label> [cases|fees]')
const here = new URL('.', import.meta.url).pathname
const root = join(here, '../..')
const work = join(root, 'work')
const out = join(here, 'results', `${label}.json`)
const proofs = join(work, `x34-proofs-${label}`)
mkdirSync(proofs, { recursive: true })
mkdirSync(join(here, 'results'), { recursive: true })
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim()
const record: Record<string, unknown> = { experiment: 34, arm: 'A', label, mode, commit, date: new Date().toISOString() }
const rows: Record<string, unknown>[] = []
record.rows = rows
const save = () => writeFileSync(out, `${JSON.stringify(record, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 1)}\n`)

// ---- programs, contracts, constants ----

const programs = { register4: assemble('register4'), scoped: assemble('scoped'), scoped_open: assemble('scoped_open') }
const rotate32 = assemble32('rotate')
record.programs = Object.fromEntries(Object.entries(programs).map(([k, v]) => [k, v.key]))
const KEYSTORE_CODE = compileYul(join(here, '../33-a-shared-keystore-for-stealth-accounts-on-the-local-chain/contracts/Keystore.yul'))
const ACCOUNT_CODE = compileYul(join(here, 'contracts/Account4.yul'))
// The addendum's capped implementation: Account4.yul with one check inserted at the start of
// validate, refusing a maximum fee per gas (TXPARAM 0x04) over 1,000 wei.
const VALIDATE = '            function validate(me) {\n'
const accountSource = readFileSync(join(here, 'contracts/Account4.yul'), 'utf8')
if (accountSource.split(VALIDATE).length !== 2) throw new Error('Account4.yul: validate not found once')
const cappedPath = join(work, 'x34-Account4Capped.yul')
writeFileSync(cappedPath, accountSource.replace(VALIDATE, `${VALIDATE}                if gt(txparam(0x04), 1000) { revert(0, 0) }\n`))
const ACCOUNT_CODE_CAPPED = compileYul(cappedPath)
const RECENT_ROOT_CODE = `0x${readFileSync(join(work, 'ethrex/scripts/hegota-testnet/recent_root/main.hex'), 'utf8').trim()}` as Hex
const DOMAIN = keccak256(toHex('exp-e2e-frames/34/deposit'))
const FEES = { maxPriorityFeePerGas: 1n, maxFeePerGas: 100n, maxFeePerBlobGas: 0n }
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as Address
const PAYMENT = 10n ** 16n
const word = (x: bigint): Hex => pad(toHex(x), { size: 32 })
const sha = (h: Hex) => bytesToHex(keccak_256(Buffer.from(h.slice(2), 'hex'))).slice(0, 14)
const seed = (l: string) => fromLabel(`x34/${l}`)
const keyOf = (l: string): Hex => bytesToHex(seed(`key/${l}`))
const accountAbi = parseAbi(['function depositAll(uint256 P)', 'function spend(address destination, uint256 amount)'])
const pool = compilePool()

// ---- the chain ----

const devKey = readFileSync(join(work, 'ethrex/fixtures/keys/private_keys_l1.txt'), 'utf8').split('\n')[0].trim() as Hex
const dev = privateKeyToAddress(devKey)
const skipFile = join(work, `x34-skip-${label}`)
writeFileSync(skipFile, '0')
process.env.X33_SLOT_SKIP_FILE = skipFile
const binary = join(work, 'ethrex-bins/ethrex-8288-clock')
// The pool's two Poseidon libraries and its Entrypoint's implementation are in the genesis, as the
// code a CREATE at these addresses would leave: EIP-8037 prices code by the byte, and each is more
// state gas than one transaction may carry on this chain (deviation 1).
const T3 = '0x0000000000000000000000000000000000034003' as Address
const T4 = '0x0000000000000000000000000000000000034004' as Address
const EP_IMPL = '0x00000000000000000000000000000000000340e1' as Address
const genesisAlloc = {
  [RECENT_ROOT.toLowerCase()]: { balance: '0x0', code: RECENT_ROOT_CODE, nonce: '0x1' },
  [T3]: { balance: '0x0', code: genesisCode(pool.PoseidonT3, T3), nonce: '0x1' },
  [T4]: { balance: '0x0', code: genesisCode(pool.PoseidonT4, T4), nonce: '0x1' },
  [EP_IMPL]: { balance: '0x0', code: genesisCode(pool.Entrypoint, EP_IMPL), nonce: '0x1' },
}
const chain: LocalChain = await startLocalChain({
  root, label: `x34-${label}`, setting: 'extended', prover: PROVER, programs: join(here, 'build'),
  alloc: genesisAlloc, chainId: 8141, binary, maxVerifyGas: 500_000,
})
const client = chain.client
// A failed step stops the node, so no stale node holds the port when the runner is next started.
process.on('uncaughtException', (e) => { console.error(e); void chain.stop().finally(() => process.exit(1)) })
const local = defineChain({ id: Number(chain.chainId), name: 'x34 local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [chain.url] } } })
const walletOf = (k: Hex) => createWalletClient({ account: privateKeyToAccount(k), chain: local, transport: http(chain.url) })
record.chain = { ethrex: chain.ethrexCommit, binary: 'ethrex-8288-clock', maxVerifyGas: 500_000, predeploy: sha(RECENT_ROOT_CODE) }
console.log(`chain ${chain.chainId}, ethrex ${chain.ethrexCommit.slice(0, 8)}`)
for (const [name, a] of [['PoseidonT3', T3], ['PoseidonT4', T4], ['Entrypoint implementation', EP_IMPL]] as const) {
  const code = await client.getCode({ address: a })
  console.log(`genesis ${name} at ${a}: ${code ? (code.length - 2) / 2 : 0} bytes`)
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
  rows.push({ ...row, receiptLogs: undefined })
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

// ---- the pool ----

const WV = await deploy('deploy the withdrawal verifier', pool.WithdrawalVerifier.abi, `0x${pool.WithdrawalVerifier.bytecode}`)
const CV = await deploy('deploy the ragequit verifier', pool.CommitmentVerifier.abi, `0x${pool.CommitmentVerifier.bytecode}`)
const initData = encodeFunctionData({ abi: pool.Entrypoint.abi, functionName: 'initialize', args: [dev, dev] } as never)
const EP = await deploy('deploy the Entrypoint proxy', pool.ERC1967Proxy.abi, `0x${pool.ERC1967Proxy.bytecode}`, [EP_IMPL, initData])
const POOL = await deploy('deploy the native-ETH pool', pool.PrivacyPoolSimple.abi, link(pool.PrivacyPoolSimple, { PoseidonT3: T3, PoseidonT4: T4 }), [EP, WV, CV])
await eoa('register the pool', devKey, { to: EP, data: encodeFunctionData({ abi: pool.Entrypoint.abi, functionName: 'registerPool', args: [NATIVE, POOL, 10n ** 12n, 0n, 100n] } as never), gas: 1_000_000n })
// The account implementation every scoped account clones, deployed once.
const ACCOUNT_IMPL = (await eoa('deploy the account implementation', devKey, { data: ACCOUNT_CODE, gas: 3_000_000n })).contract as Address
const ACCOUNT_IMPL_CAPPED = mode === 'fees' ? (await eoa('deploy the capped account implementation', devKey, { data: ACCOUNT_CODE_CAPPED, gas: 3_000_000n })).contract as Address : undefined
record.accountImplementations = { plain: { address: ACCOUNT_IMPL, code: sha(ACCOUNT_CODE) }, capped: ACCOUNT_IMPL_CAPPED && { address: ACCOUNT_IMPL_CAPPED, code: sha(ACCOUNT_CODE_CAPPED) } }
const SCOPE = (await call(POOL, pool.PrivacyPoolSimple.abi, 'SCOPE')) as bigint
record.pool = { entrypoint: EP, implementation: EP_IMPL, pool: POOL, scope: SCOPE, poseidonT3: T3, poseidonT4: T4, inGenesis: ['PoseidonT3', 'PoseidonT4', 'Entrypoint implementation'], withdrawalVerifier: WV, ragequitVerifier: CV, minimumDeposit: 10n ** 12n, vettingFeeBPS: 0, maxRelayFeeBPS: 100 }
save()

const h = await poseidon()
const state = new LeanIMT(h)
const asp = new LeanIMT(h)
const notes = new Map<bigint, { label: bigint; value: bigint; commitment: bigint }>()
/** The pool's own deposit event, the state tree updated from it and checked against the pool. */
async function observeDeposit(logs: { address: Address; topics: Hex[]; data: Hex }[]) {
  for (const l of logs) {
    if (l.address.toLowerCase() !== POOL.toLowerCase()) continue
    try {
      const ev = decodeEventLog({ abi: pool.PrivacyPoolSimple.abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as unknown as { eventName: string; args: Record<string, bigint> }
      if (ev.eventName !== 'Deposited') continue
      state.insert(ev.args._commitment)
      notes.set(ev.args._precommitmentHash, { label: ev.args._label, value: ev.args._value, commitment: ev.args._commitment })
      const onChain = (await call(POOL, pool.PrivacyPoolSimple.abi, 'currentRoot')) as bigint
      if (onChain !== state.root()) throw new Error('the state tree is not the pool\'s')
      // The postman admits every deposit.
      asp.insert(ev.args._label)
      await eoa('postman: admit the deposit', devKey, { to: EP, data: encodeFunctionData({ abi: pool.Entrypoint.abi, functionName: 'updateRoot', args: [asp.root(), 'x34-local-postman-admits-every-deposit-0000000000'] } as never), gas: 3_000_000n })
      return ev.args
    } catch (e) { if (String(e).includes('not the pool')) throw e }
  }
  return undefined
}

/** A note's secrets, from a seed: n and t below P, and P = Poseidon(n, t). */
const noteOf = (l: string) => {
  const n = BigInt(bytesToHex(seed(`note/${l}/n`))) % P
  const t = BigInt(bytesToHex(seed(`note/${l}/t`))) % P
  return { n, t, pc: h([n, t]) }
}
/** Withdraw a whole note to `to`, the withdrawer sending the call from `key`. */
async function withdraw(step: string, key: Hex, note: { n: bigint; t: bigint; pc: bigint }) {
  const info = notes.get(note.pc)
  if (!info) throw new Error(`${step}: no deposit for that precommitment`)
  const to = privateKeyToAddress(key)
  const context = contextOf(to, '0x', SCOPE)
  const sp = state.proof(state.indexOf(info.commitment))
  const ap = asp.proof(asp.indexOf(info.label))
  const fresh = { n: BigInt(bytesToHex(seed(`change/${step}/n`))) % P, t: BigInt(bytesToHex(seed(`change/${step}/t`))) % P }
  const g = await groth16('withdraw', {
    withdrawnValue: info.value, stateRoot: sp.root, stateTreeDepth: sp.depth, ASPRoot: ap.root, ASPTreeDepth: ap.depth, context,
    label: info.label, existingValue: info.value, existingNullifier: note.n, existingSecret: note.t, newNullifier: fresh.n, newSecret: fresh.t,
    stateSiblings: sp.siblings, stateIndex: sp.index, ASPSiblings: ap.siblings, ASPIndex: ap.index,
  })
  const before = await client.getBalance({ address: to })
  const row = await eoa(step, key, { to: POOL, data: encodeFunctionData({ abi: pool.PrivacyPoolSimple.abi, functionName: 'withdraw', args: [{ processooor: to, data: '0x' }, g.sol] } as never), gas: 6_000_000n })
  const after = await client.getBalance({ address: to })
  const paid = after - before + BigInt(row.gasUsed) * (row.effectiveGasPrice as bigint)
  // The withdrawal inserts its change note, of value zero here, into the state tree.
  const ev = (row.logs as { address: Address; topics: Hex[]; data: Hex }[]).filter((l) => l.address.toLowerCase() === POOL.toLowerCase())
    .map((l) => { try { return decodeEventLog({ abi: pool.PrivacyPoolSimple.abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as unknown as { eventName: string; args: Record<string, bigint> } } catch { return undefined } })
    .find((e) => e?.eventName === 'Withdrawn')
  if (!ev) throw new Error(`${step}: no Withdrawn event`)
  state.insert(ev.args._newCommitment)
  if ((await call(POOL, pool.PrivacyPoolSimple.abi, 'currentRoot')) as bigint !== state.root()) throw new Error('the state tree is not the pool\'s')
  rows[rows.length - 1] = { ...rows[rows.length - 1], groth16Ms: g.ms, groth16Verified: g.ok, withdrawn: info.value, paidToWithdrawer: paid }
  return { row, paid, g }
}

// ---- identities and accounts ----

const deviceNotes = [0, 1, 2, 3].map((i) => noteOf(`device/${i}`))
const mkId = (name: string): Identity4 => ({ s: seed(`${name}/s`), version: 0, main: { rule: 1n, seeds: [seed(`${name}/main`)] }, scopeSeed: seed(`${name}/indexer`), list: deviceNotes.map((x) => word32(x.pc)), rec: seed(`${name}/rec`), salt: seed(`${name}/salt`) })
const Ibound = mkId('bound')
const Iopen = mkId('open')
await register('register the bound identity', Ibound)
await register('register the open identity', Iopen)

type Acct = { id: Identity4; r: Uint8Array; C: Hex; address: Address; vk: Hex; initcode: Hex; program: 'scoped' | 'scoped_open' }
// EIP-1167's runtime with the account's words appended after it, behind the creation code that
// copies the whole runtime out.
function cloneInitcode(impl: Address, words: Hex[]): Hex {
  const runtime = concatHex(['0x363d3d373d3d3d363d73', impl, '0x5af43d82803e903d91602b57fd5bf3', ...words])
  const n = (runtime.length - 2) / 2
  if (n > 0xff) throw new Error('clone runtime over 255 bytes')
  return concatHex([`0x3d60${n.toString(16).padStart(2, '0')}80600a3d3981f3`, runtime])
}
function accountFor(id: Identity4, rl: string, program: 'scoped' | 'scoped_open', impl: Address = ACCOUNT_IMPL): Acct {
  const r = seed(rl)
  const C = hx(accountOf(id.s, r))
  const vk = programs[program].key
  const initcode = cloneInitcode(impl, [C, vk, sourceId, pad(EP, { size: 32 })])
  return { id, r, C, address: create2Address(initcode, C), vk, initcode, program }
}
const relayer = privateKeyToAddress(keyOf('relayer'))

const depositAllData = (pc: bigint): Hex => encodeFunctionData({ abi: accountAbi, functionName: 'depositAll', args: [pc] })
const depositAllFrame = (account: Address, pc: bigint, lim = { execution: 2_000_000n, state: 10n * STORAGE_SET_STATE_GAS }): Frame => senderFrame({ target: account, data: depositAllData(pc), ...lim })
/** eth_call from `from` to `to`, returning the revert data and the pool's or Entrypoint's error name. */
async function revertOf(from: Address, to: Address, data: Hex, value = 0n) {
  const res = await fetch(chain.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ from, to, data, value: toHex(value), gas: '0x' + (2_000_000).toString(16) }, 'latest'] }) })
  const j = (await res.json()) as { result?: Hex; error?: { data?: Hex; message?: string } }
  const rd = j.error?.data
  if (!rd) return { data: j.result ?? null, name: j.error ? `reverted without data: ${j.error.message}` : 'did not revert' }
  for (const abi of [pool.Entrypoint.abi, pool.PrivacyPoolSimple.abi]) {
    try { return { data: rd, name: decodeErrorResult({ abi, data: rd }).errorName } } catch { /* next */ }
  }
  return { data: rd, name: undefined }
}
/** The scoped transaction, deploying the account first if it has no code. */
type ScopedOpts = { call?: Frame; refusable?: boolean; noDeploy?: boolean; sender?: { execution: bigint; state: bigint }; relayerFee?: { leave: bigint } }
async function scopedTx(step: string, a: Acct, pc: bigint, o: ScopedOpts = {}) {
  const code = await client.getCode({ address: a.address })
  const deployFirst = !o.noDeploy && (!code || code === '0x')
  const nonce = await getNonceSeq(client, a.address, [0n])
  const pcWord = word32(pc)
  const m = keccak256(concatHex([DOMAIN, pad(a.address), word(nonce), word(pc)]))
  const sin = scopedInput(ks, a.id, a.r, Buffer.from(m.slice(2), 'hex'), pcWord)
  const file = join(proofs, `${step.replace(/\W+/g, '-')}.bin`)
  const p = prove(programs[a.program].path, { ...sin.input, proofOut: file })
  if ('error' in p) {
    const row = { step, outcome: 'refused by the prover', error: p.error.slice(0, 240), inList: sin.inList, program: a.program }
    console.log(`${step}: refused by the prover`)
    rows.push(row)
    return row
  }
  chain.putStarkWitness(hx(sin.D), a.vk, readFileSync(file))
  const tuple = concatHex([sourceId, pad(toHex(last.slot), { size: 8 }), last.rho])
  const deployFrame: Frame = { mode: 0, flags: 0, target: CREATE2_DEPLOYER, limits: { execution: 150_000n, state: 460_000n }, value: 0n, data: concatHex([a.C, a.initcode]) }
  const tx: FrameTx = {
    chainId: chain.chainId, nonceKeys: [0n], nonceSeq: nonce, sender: a.address,
    frames: [
      rrFrame(tuple),
      ...(deployFirst ? [deployFrame] : []),
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, data: '0x', execution: 60_000n, state: 0n }),
      depFrame(tripleOf(hx(sin.D), a.vk)),
      o.call ?? depositAllFrame(a.address, pc, o.sender),
    ],
    signatures: [], fees: FEES, blobVersionedHashes: [],
  }
  const balanceBefore = await client.getBalance({ address: a.address })
  // The relayer's fee (addendum): the transaction's total gas limit L from the node's reserved cost
  // at run 1's fees, then a maximum and priority fee f = floor((B - leave) / L).
  let feeChoice: Record<string, bigint> | undefined
  if (o.relayerFee) {
    const sim0 = await simulateFrameTx(client, tx)
    const maxCost = BigInt(sim0.maxCost)
    if (maxCost % FEES.maxFeePerGas !== 0n) throw new Error(`${step}: reserved cost ${maxCost} is not a multiple of the fee`)
    const L = maxCost / FEES.maxFeePerGas
    const f = (balanceBefore - o.relayerFee.leave) / L
    tx.fees = { maxPriorityFeePerGas: f, maxFeePerGas: f, maxFeePerBlobGas: 0n }
    feeChoice = { L, f, reserved: L * f, leftToDeposit: balanceBefore - L * f }
  }
  const relayerBefore = await client.getBalance({ address: relayer })
  const row = await frames(step, tx, { account: a.address, program: a.program, deployFirst, inList: sin.inList, proof: { cycles: p.cycles, proofBytes: p.proofBytes, proveMs: p.warmupMs } }, o.refusable ?? false)
  const at = rows.length - 1
  const balanceAfter = await client.getBalance({ address: a.address })
  const relayerAfter = await client.getBalance({ address: relayer })
  // A refused call shape: the same transaction with depositAll(P) as its call, simulated, shows the
  // refusal is the call's and not the deployment's, the proof's or the tuple's.
  // A refused fee (addendum): the same transaction at run 1's fees, simulated.
  const control = (o.call || o.relayerFee) && !('receiptLogs' in row)
    ? await simulateFrameTx(client, { ...tx, frames: o.call ? [...tx.frames.slice(0, -1), depositAllFrame(a.address, pc)] : tx.frames, fees: FEES }).then((r) => ({ valid: r.valid, violation: r.violation ?? null }), (e) => ({ valid: false, violation: (e as Error).message.slice(0, 200) }))
    : undefined
  // The block's fee recipient: the priority fee paid, and its balance across the block.
  let feeRecipient: Record<string, unknown> | undefined
  if (mode === 'fees' && 'block' in row) {
    const blk = await client.getBlock({ blockNumber: BigInt(row.block as number) })
    const base = blk.baseFeePerGas ?? 0n
    const perGas = tx.fees.maxPriorityFeePerGas < tx.fees.maxFeePerGas - base ? tx.fees.maxPriorityFeePerGas : tx.fees.maxFeePerGas - base
    const before = await client.getBalance({ address: blk.miner, blockNumber: blk.number - 1n })
    const after = await client.getBalance({ address: blk.miner, blockNumber: blk.number })
    feeRecipient = { address: blk.miner, baseFee: base, priorityPerGas: perGas, priorityPaid: BigInt(row.gasUsed as number) * perGas, before, after, delta: after - before, transactionsInBlock: blk.transactions.length }
  }
  // A failed SENDER frame: the Entrypoint's record of P, and the account's deposit replayed from an
  // EOA with the account's balance, for the revert reason. An eth_call from the account itself is
  // refused, its sender having code (EIP-3607).
  const lastFrame = 'frames' in row ? (row.frames as { status: number }[]).at(-1) : undefined
  const replay = lastFrame && lastFrame.status !== 1
    ? { usedPrecommitment: (await call(EP, pool.Entrypoint.abi, 'usedPrecommitments', [pc])) as boolean, ...(await revertOf(privateKeyToAccount(devKey).address, EP, encodeFunctionData({ abi: pool.Entrypoint.abi, functionName: 'deposit', args: [pc] } as never), balanceAfter)) }
    : undefined
  const dep = 'receiptLogs' in row ? await observeDeposit(row.receiptLogs as never) : undefined
  rows[at] = { ...rows[at], accountBefore: balanceBefore, accountAfter: balanceAfter, relayerBefore, relayerAfter, deposited: dep?._value, control, replay, fees: tx.fees, feeChoice, feeRecipient }
  if (control) console.log(`  control, the same transaction ${o.call ? 'calling depositAll(P)' : 'at run 1\'s fees'}: ${control.valid ? 'valid' : `invalid: ${control.violation}`}`)
  if (feeChoice) console.log(`  relayer's fee: L ${feeChoice.L}, f ${feeChoice.f}, left to deposit ${feeChoice.leftToDeposit}`)
  if (feeRecipient) console.log(`  fee recipient: priority paid ${feeRecipient.priorityPaid}, balance change ${feeRecipient.delta}, account ${balanceBefore} -> ${balanceAfter}, deposited ${dep?._value}`)
  if (replay) console.log(`  usedPrecommitments(P) ${replay.usedPrecommitment}; deposit(P) replayed from an EOA: ${replay.name ?? replay.data}`)
  return { ...row, deposited: dep?._value }
}

if (mode === 'cases') {
  // (a) Honest: a payment, then the relayer deploys and deposits the first listed precommitment; the
  // owner's device withdraws with its own secrets.
  const A1 = accountFor(Ibound, 'bound/r/1', 'scoped')
  await eoa('(a) a payment to the bound account', devKey, { to: A1.address, value: PAYMENT, gas: 500_000n })
  const a = await scopedTx('(a) deploy and deposit, the first listed precommitment', A1, deviceNotes[0].pc)
  const device = keyOf('device')
  await eoa('fund the device for its withdrawal', devKey, { to: privateKeyToAddress(device), value: 10n ** 17n, gas: 500_000n })
  const wa = await withdraw('(a) the owner\'s device withdraws', device, deviceNotes[0])
  record.a = { deposited: (a as { deposited?: bigint }).deposited, paid: wa.paid }

  // (b) Control: the scope fixes the pool only; the indexer deposits its own precommitment and withdraws.
  const A2 = accountFor(Iopen, 'open/r/1', 'scoped_open')
  const indexerNote = noteOf('indexer/0')
  await eoa('(b) a payment to the open account', devKey, { to: A2.address, value: PAYMENT, gas: 500_000n })
  const b = await scopedTx('(b) deploy and deposit, the indexer\'s own precommitment', A2, indexerNote.pc)
  const indexer = keyOf('indexer')
  await eoa('fund the indexer for its withdrawal', devKey, { to: privateKeyToAddress(indexer), value: 10n ** 17n, gas: 500_000n })
  const wb = await withdraw('(b) the indexer withdraws to itself', indexer, indexerNote)
  record.b = { deposited: (b as { deposited?: bigint }).deposited, paid: wb.paid }

  // (c) The substitution with the list.
  const A3 = accountFor(Ibound, 'bound/r/3', 'scoped')
  await eoa('(c) a payment to a second bound account', devKey, { to: A3.address, value: PAYMENT, gas: 500_000n })
  await scopedTx('(c) the indexer\'s own precommitment, under the list', A3, noteOf('indexer/1').pc, { refusable: true })

  // (d) A list entry used twice: another account of the same identity deposits (a)'s precommitment.
  const A4 = accountFor(Ibound, 'bound/r/4', 'scoped')
  await eoa('(d) a payment to a third bound account', devKey, { to: A4.address, value: PAYMENT, gas: 500_000n })
  await scopedTx('(d) the precommitment (a) used, again', A4, deviceNotes[0].pc, { refusable: true })

  // (e) Other calls under the scoped key, on the undeployed second account, deploying it first.
  const e1 = senderFrame({ target: A3.address, data: encodeFunctionData({ abi: accountAbi, functionName: 'spend', args: [privateKeyToAddress(keyOf('elsewhere')), PAYMENT / 2n] }), execution: 200_000n, state: 0n })
  await scopedTx('(e1) a transfer', A3, deviceNotes[1].pc, { call: e1, refusable: true })
  const e2 = senderFrame({ target: privateKeyToAddress(keyOf('another-entrypoint')), data: encodeFunctionData({ abi: pool.Entrypoint.abi, functionName: 'deposit', args: [deviceNotes[1].pc] } as never), value: 0n, execution: 200_000n, state: 0n })
  await scopedTx('(e2) a deposit to another Entrypoint, sent directly', A3, deviceNotes[1].pc, { call: e2, refusable: true })
  const e3 = senderFrame({ target: POOL, data: '0x', execution: 200_000n, state: 0n })
  await scopedTx('(e3) a call to the pool, sent directly', A3, deviceNotes[1].pc, { call: e3, refusable: true })
}

if (mode === 'fees') {
  // (f2) The fee, chosen by the relayer: the SENDER frame's limits close to its use, and a fee that
  // leaves about twice the pool's minimum deposit after the reserved cost.
  const relayerChoice = { sender: { execution: 300_000n, state: 783_360n }, relayerFee: { leave: 2n * 10n ** 12n }, refusable: true }
  const F2 = accountFor(Ibound, 'bound/r/f2', 'scoped')
  await eoa('(f2) a payment to a fresh bound account', devKey, { to: F2.address, value: PAYMENT, gas: 500_000n })
  record.f2 = await scopedTx('(f2) deploy and deposit, at the relayer\'s fee', F2, deviceNotes[0].pc, relayerChoice)
  // (f3a) The honest transaction on a capped account.
  const F3a = accountFor(Ibound, 'bound/r/f3a', 'scoped', ACCOUNT_IMPL_CAPPED)
  await eoa('(f3a) a payment to a fresh capped account', devKey, { to: F3a.address, value: PAYMENT, gas: 500_000n })
  record.f3a = await scopedTx('(f3a) deploy and deposit, capped, at run 1\'s fees', F3a, deviceNotes[1].pc, { refusable: true })
  // (f3b) The relayer's fee on a capped account.
  const F3b = accountFor(Ibound, 'bound/r/f3b', 'scoped', ACCOUNT_IMPL_CAPPED)
  await eoa('(f3b) a payment to another fresh capped account', devKey, { to: F3b.address, value: PAYMENT, gas: 500_000n })
  record.f3b = await scopedTx('(f3b) deploy and deposit, capped, at the relayer\'s fee', F3b, deviceNotes[2].pc, relayerChoice)
}

record.relayer = { address: relayer, balance: await client.getBalance({ address: relayer }) }
record.builds = chain.builds().length
record.finished = new Date().toISOString()
save()
await chain.stop()
console.log(`wrote ${out}`)
