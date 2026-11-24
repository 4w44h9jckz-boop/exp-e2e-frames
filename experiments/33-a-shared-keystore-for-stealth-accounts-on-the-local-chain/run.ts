// Experiment 33, run: the shared keystore on the local chain, every case of the README but (f), which
// runs.ts's second phase takes on the maximum-age binary (fixRun below).
//
// usage: npx tsx experiments/33-a-shared-keystore-for-stealth-accounts-on-the-local-chain/run.ts <label> [main|fix|both]
//
// Writes results/<label>.json. Keys and seeds come from public labels, and the chain's payer is
// ethrex's first published dev key, so the record holds no secret worth keeping.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { keccak_256 } from '@noble/hashes/sha3'
import { type Address, type Hex, bytesToHex, concatHex, createWalletClient, defineChain, encodeFunctionData, encodePacked, http, keccak256, pad, parseAbi, toHex } from 'viem'
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts'
import { compileYul } from '../../src/exp-frames/contracts.js'
import { create2Address } from '../../src/exp-frames/deploy.js'
import {
  Approve, CREATE2_DEPLOYER, type Frame, type FrameTx, RECENT_ROOT, STORAGE_SET_STATE_GAS, frameReceiptGas, frameReceiptStatus, frameTxHash, getNonceSeq, senderFrame,
  serializeFrameTx, simulateFrameTx, verifyFrame, waitForFrameTxReceipt,
} from '../../src/exp-frames/frametx/index.js'
import { type LocalChain, startLocalChain } from '../../src/e2e/localchain.js'
import { Keystore, accountOf, cellOfInt, entryOf, kappaOf, pair } from '../32-a-shared-keystore-for-stealth-accounts-in-leanvm/keystore.js'
import { type Identity, MODE, PROVER, type Rule, assemble, digestOf, fromLabel, prove, registerInput, rotateInput, spendInput } from '../32-a-shared-keystore-for-stealth-accounts-in-leanvm/x32.js'
const [label, phase = 'both'] = process.argv.slice(2)
if (!label) throw new Error('usage: run.ts <label> [main|fix|both]')
const here = new URL('.', import.meta.url).pathname
const root = join(here, '../..')
const work = join(root, 'work')
const out = join(here, 'results', `${label}.json`)
const proofs = join(work, `x33-proofs-${label}`)
mkdirSync(proofs, { recursive: true })
mkdirSync(join(here, 'results'), { recursive: true })
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim()
const sha = (f: string) => bytesToHex(keccak_256(readFileSync(f))).slice(0, 14)

const record: Record<string, unknown> = { experiment: 33, label, commit, date: new Date().toISOString() }
const save = () => writeFileSync(out, `${JSON.stringify(record, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 1)}\n`)

// ---- programs, contracts, constants ----

const programs = { spend: assemble('spend'), register: assemble('register'), rotate: assemble('rotate') }
record.programs = Object.fromEntries(Object.entries(programs).map(([k, v]) => [k, v.key]))
const KEYSTORE_CODE = compileYul(join(here, 'contracts/Keystore.yul'))
const ACCOUNT_CODE = compileYul(join(here, 'contracts/Account.yul'))
const RECENT_ROOT_CODE = `0x${readFileSync(join(work, 'ethrex/scripts/hegota-testnet/recent_root/main.hex'), 'utf8').trim()}` as Hex
const DOMAIN = keccak256(toHex('exp-e2e-frames/33/spend'))
const FEES = { maxPriorityFeePerGas: 1n, maxFeePerGas: 100n, maxFeePerBlobGas: 0n }
const LEANSTARK = 0x11n
const DEP_GAS = 30_000n
const AMOUNT = 10n ** 12n
const NEW_ACCOUNT_STATE = 183_600n
const word = (x: bigint): Hex => pad(toHex(x), { size: 32 })
const hx = (b: Uint8Array): Hex => bytesToHex(b)
const stealthAbi = parseAbi(['function spend(address destination, uint256 amount)'])
const fresh = (l: string): Address => privateKeyToAddress(bytesToHex(fromLabel(`fresh/${l}`)))

// ---- one chain's session ----

type Row = Record<string, unknown>
class Session {
  rows: Row[] = []
  constructor(public chain: LocalChain, public devKey: Hex, public skipFile: string) {}
  get client() { return this.chain.client }
  wallet() {
    const local = defineChain({ id: Number(this.chain.chainId), name: 'x33 local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [this.chain.url] } } })
    return createWalletClient({ account: privateKeyToAccount(this.devKey), chain: local, transport: http(this.chain.url) })
  }
  async block(n?: bigint) {
    const b = await this.client.request({ method: 'eth_getBlockByNumber', params: [n === undefined ? 'latest' : toHex(n), false] } as never) as Record<string, Hex>
    return { number: BigInt(b.number), slot: b.slotNumber !== undefined ? BigInt(b.slotNumber) : undefined }
  }
  async eoa(step: string, req: { to?: Address; data?: Hex; value?: bigint; gas: bigint }) {
    const w = this.wallet()
    const hash = await w.sendTransaction({ ...req, maxFeePerGas: 10n ** 10n, maxPriorityFeePerGas: 1n } as never)
    const r = await this.client.waitForTransactionReceipt({ hash, timeout: 180_000 })
    const b = await this.block(r.blockNumber)
    const row = { step, hash, block: Number(r.blockNumber), slot: b.slot, status: r.status, gasUsed: Number(r.gasUsed), contract: r.contractAddress }
    console.log(`${step}: ${r.status} gas ${r.gasUsed} block ${r.blockNumber} slot ${b.slot}`)
    this.rows.push(row)
    if (r.status !== 'success') throw new Error(`${step}: ${r.status}`)
    return row
  }
  /** Simulate, then send; a refusal is recorded, and thrown only where it was not expected. */
  async frames(step: string, tx: FrameTx, extra: Row = {}, refusable = false, waitBlocks = 0) {
    const raw = serializeFrameTx(tx)
    const hash = frameTxHash(tx)
    const sim = await simulateFrameTx(this.client, tx).catch((e) => ({ valid: false, violation: (e as Error).message.slice(0, 300) }))
    let sent: string | undefined
    try { await this.client.request({ method: 'eth_sendRawTransaction', params: [raw] } as never) } catch (e) { sent = String((e as { details?: string }).details ?? (e as Error).message).slice(0, 400) }
    const calldataBytes = tx.frames.reduce((n, f) => n + (f.data.length - 2) / 2, 0)
    if (sent) {
      const row = { step, outcome: 'refused by the node', refusal: sent, simulation: sim, calldataBytes, ...extra }
      console.log(`${step}: refused: ${sent.slice(0, 200)}`)
      this.rows.push(row)
      if (!refusable) throw new Error(`${step}: refused: ${sent}`)
      return row
    }
    if (waitBlocks) {
      // Wait for `waitBlocks` more blocks, or 60 seconds; a head that does not move is recorded.
      const start = await this.block()
      const t0 = Date.now()
      for (;;) {
        const r = await this.client.request({ method: 'eth_getTransactionReceipt', params: [hash] } as never).catch(() => null)
        if (r) break
        const b = await this.block()
        if (b.number >= start.number + BigInt(waitBlocks) || Date.now() - t0 > 60_000) {
          const head = b.number === start.number ? 'the head did not move' : `the head moved ${b.number - start.number} blocks`
          const lastCheck = this.chain.checks().slice(-1)[0]
          const row = { step, outcome: `admitted, not included; ${head} in ${Math.round((Date.now() - t0) / 1000)} s`, hash, headAtSend: start.number, head: b.number, lastBlockCheck: lastCheck, simulation: sim, calldataBytes, ...extra }
          console.log(`${step}: not included; ${head}`)
          this.rows.push(row)
          return row
        }
        await new Promise((res) => setTimeout(res, 1000))
      }
    }
    const r = await waitForFrameTxReceipt(this.client, hash, { timeoutMs: 240_000 })
    const frames = r.frameReceipts.map((f) => ({ status: frameReceiptStatus(f), ...frameReceiptGas(f) }))
    const ok = frames.every((f) => f.status === 1)
    const b = await this.block(BigInt(r.blockNumber))
    const row = { step, outcome: ok ? 'included' : 'included, a frame failed', hash, block: Number(BigInt(r.blockNumber)), slot: b.slot, gasUsed: Number(BigInt(r.gasUsed)), frames: frames.map((f) => ({ status: f.status, execution: Number(f.execution), state: Number(f.state) })), calldataBytes, simulation: { valid: sim.valid, violation: (sim as { violation?: string }).violation }, ...extra }
    console.log(`${step}: ${row.outcome} block ${row.block} slot ${b.slot} gas ${row.gasUsed} frames ${frames.map((f) => `${f.status}:${f.execution}+${f.state}s`).join(' / ')}`)
    this.rows.push(row)
    if (!ok && !refusable) throw new Error(`${step}: a frame failed`)
    return row
  }
  async skipSlots(n: number) {
    const before = await this.block()
    writeFileSync(this.skipFile, String(n))
    for (;;) {
      const b = await this.block()
      if (b.slot !== undefined && before.slot !== undefined && b.slot > before.slot + BigInt(n)) return { before, after: b }
      await new Promise((res) => setTimeout(res, 500))
    }
  }
}

// ---- frames ----

const depFrame = (triple: Hex): Frame => ({ mode: 4, flags: 0, target: null, limits: { execution: DEP_GAS, state: 0n }, value: 0n, data: triple })
const tripleOf = (d: Hex, vk: Hex): Hex => concatHex([word(LEANSTARK), d, vk])
const tupleOf = (sourceId: Hex, slot: bigint, rho: Hex): Hex => concatHex([sourceId, pad(toHex(slot), { size: 8 }), rho])
const tupleMaxAge = (sourceId: Hex, slot: bigint, rho: Hex, maxAge: bigint): Hex => concatHex(['0x01', sourceId, pad(toHex(slot), { size: 8 }), rho, pad(toHex(maxAge), { size: 8 })])
const rrFrame = (data: Hex): Frame => verifyFrame({ scope: Approve.NONE, target: RECENT_ROOT, data, execution: 20_000n, state: 0n })

function spendTx(chainId: bigint, account: Address, nonce: bigint, tuple: Hex, triple: Hex, destination: Address, reading: 1 | 2): FrameTx {
  const verify = verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, data: '0x', execution: 60_000n, state: 0n })
  const dep = depFrame(triple)
  return {
    chainId, nonceKeys: [0n], nonceSeq: nonce, sender: account,
    frames: [rrFrame(tuple), ...(reading === 2 ? [verify, dep] : [dep, verify]), senderFrame({ target: account, data: encodeFunctionData({ abi: stealthAbi, functionName: 'spend', args: [destination, AMOUNT] }), execution: 60_000n, state: NEW_ACCOUNT_STATE })],
    signatures: [], fees: FEES, blobVersionedHashes: [],
  }
}
const messageOf = (account: Address, nonce: bigint, destination: Address): Hex => keccak256(concatHex([DOMAIN, pad(account), word(nonce), pad(destination), word(AMOUNT)]))

// ---- the keystore on chain, mirrored by experiment 32's reference ----

class Store {
  ks = new Keystore()
  address!: Address
  sourceId!: Hex
  last!: { slot: bigint; rho: Hex }
  constructor(public s: Session) {}
  async deploy() {
    const initcode = concatHex([KEYSTORE_CODE, programs.register.key as Hex, programs.rotate.key as Hex])
    const row = await this.s.eoa('deploy the keystore', { data: initcode, gas: 5_000_000n })
    this.address = row.contract as Address
    this.sourceId = keccak256(encodePacked(['address', 'bytes32'], [this.address, pad('0x00', { size: 32 })]))
    await this.s.eoa('fund the keystore', { to: this.address, value: 10n ** 18n, gas: 100_000n })
    this.last = { slot: (row as { slot?: bigint }).slot as bigint, rho: hx(this.ks.root()) }
    await this.check('deploy')
    return row
  }
  async onChainRoot() {
    const r = await this.s.client.call({ to: this.address, data: '0xebf0c717' })
    return r.data as Hex
  }
  async check(what: string) {
    const chain = await this.onChainRoot()
    const ref = hx(this.ks.root())
    if (chain !== ref) throw new Error(`${what}: the keystore's root ${chain} is not the reference's ${ref}`)
  }
  private siblings(p: { kids: [Uint8Array, Uint8Array][]; bits: number[] }): Hex[] {
    return p.kids.map(([l, r], i) => hx(p.bits[i] ? l : r))
  }
  private tx(nonce: bigint, triple: Hex, data: Hex): FrameTx {
    return {
      chainId: this.s.chain.chainId, nonceKeys: [0n], nonceSeq: nonce, sender: this.address,
      frames: [
        verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, data: '0x', execution: 80_000n, state: 0n }),
        depFrame(triple),
        senderFrame({ target: this.address, data, execution: 800_000n, state: 8n * STORAGE_SET_STATE_GAS }),
      ],
      signatures: [], fees: FEES, blobVersionedHashes: [],
    }
  }
  async register(step: string, id: Identity) {
    const reg = registerInput(id)
    const file = join(proofs, `${step.replace(/\W+/g, '-')}.bin`)
    const p = prove(programs.register.path, { ...reg.input, proofOut: file })
    if ('error' in p) throw new Error(`${step}: ${p.error}`)
    const D = hx(reg.D)
    this.s.chain.putStarkWitness(D, programs.register.key as Hex, readFileSync(file))
    const pathT = this.siblings(this.ks.leaves.path(this.ks.leaves.size))
    const data = concatHex(['0xb4016cff', hx(reg.leaf), hx(reg.q), ...pathT])
    const nonce = await getNonceSeq(this.s.client, this.address, [0n])
    const row = await this.s.frames(step, this.tx(nonce, tripleOf(D, programs.register.key as Hex), data), { proof: { cycles: p.cycles, proofBytes: p.proofBytes } })
    this.ks.register(reg.leaf, reg.q)
    this.last = { slot: (row as { slot?: bigint }).slot as bigint, rho: hx(this.ks.root()) }
    await this.check(step)
    return row
  }
  async rotate(step: string, id: Identity, next: { rule: Rule; rec: Uint8Array; salt: Uint8Array }) {
    const r = rotateInput(this.ks, id, next, MODE.rotate)
    const file = join(proofs, `${step.replace(/\W+/g, '-')}.bin`)
    const p = prove(programs.rotate.path, { ...r.input, proofOut: file })
    if ('error' in p) throw new Error(`${step}: ${p.error}`)
    const D = hx(r.D)
    this.s.chain.putStarkWitness(D, programs.rotate.key as Hex, readFileSync(file))
    const kappa = kappaOf(r.n)
    const e = this.ks.bracket(kappa)!
    const pathE = this.siblings(this.ks.revoked.path(e.index))
    const t2 = this.ks.revoked.clone()
    t2.set(e.index, entryOf(e.a, kappa))
    const pathA = this.siblings(t2.path(t2.size))
    const pathT = this.siblings(this.ks.leaves.path(this.ks.leaves.size))
    const ab = hx(pair(cellOfInt(e.a), cellOfInt(e.b)))
    const data = concatHex(['0x6d2be516', hx(this.ks.root()), hx(r.n), hx(r.nextLeaf), ab, word(BigInt(e.index)), ...pathE, ...pathA, ...pathT])
    const nonce = await getNonceSeq(this.s.client, this.address, [0n])
    const row = await this.s.frames(step, this.tx(nonce, tripleOf(D, programs.rotate.key as Hex), data), { proof: { cycles: p.cycles, proofBytes: p.proofBytes } })
    this.ks.rotate(r.n, r.nextLeaf)
    this.last = { slot: (row as { slot?: bigint }).slot as bigint, rho: hx(this.ks.root()) }
    await this.check(step)
    return row
  }
  async refresh(step: string) {
    const row = await this.s.eoa(step, { to: this.address, data: '0xf8ac93e8', gas: 300_000n })
    this.last = { slot: (row as { slot?: bigint }).slot as bigint, rho: hx(this.ks.root()) }
    return row
  }
}

// ---- accounts ----

type Acct = { id: Identity; r: Uint8Array; C: Hex; address: Address; bound: bigint }
async function deployAccount(s: Session, store: Store, step: string, id: Identity, rLabel: string, bound = 0n): Promise<Acct> {
  const r = fromLabel(rLabel)
  const C = hx(accountOf(id.s, r))
  const initcode = concatHex([ACCOUNT_CODE, C, programs.spend.key as Hex, store.sourceId, word(bound)])
  const address = create2Address(initcode, C)
  const row = await s.eoa(step, { to: CREATE2_DEPLOYER, data: concatHex([C, initcode]), gas: 3_000_000n })
  await s.eoa(`${step}: fund`, { to: address, value: 10n ** 16n, gas: 100_000n })
  return { id, r, C, address, bound, ...({ deploy: row } as object) } as Acct
}

/** A spend's proof and transaction against `ks` and the tuple naming its root. */
async function spend(s: Session, step: string, a: Acct, at: { ks: Keystore; slot: bigint; rho: Hex }, store: Store, o: { reading?: 1 | 2; maxAge?: bigint; idOverride?: Identity; noProof?: boolean; refusable?: boolean; waitBlocks?: number } = {}) {
  const id = o.idOverride ?? a.id
  const nonce = await getNonceSeq(s.client, a.address, [0n])
  const destination = fresh(`${step}/${nonce}`)
  const m = messageOf(a.address, nonce, destination)
  const input = spendInput(at.ks, id, a.r, Buffer.from(m.slice(2), 'hex'))
  const D = hx(input.D)
  let proof: Row = { attempted: false }
  if (!o.noProof) {
    const file = join(proofs, `${step.replace(/\W+/g, '-')}.bin`)
    const p = prove(programs.spend.path, { ...input.input, proofOut: file })
    if ('error' in p) proof = { refusedByProver: p.error.slice(0, 200) }
    else { proof = { cycles: p.cycles, proofBytes: p.proofBytes }; s.chain.putStarkWitness(D, programs.spend.key as Hex, readFileSync(file)) }
  }
  const tuple = o.maxAge !== undefined ? tupleMaxAge(store.sourceId, at.slot, at.rho, o.maxAge) : tupleOf(store.sourceId, at.slot, at.rho)
  const tx = spendTx(s.chain.chainId, a.address, nonce, tuple, tripleOf(D, programs.spend.key as Hex), destination, o.reading ?? 2)
  const now = await s.block()
  return s.frames(step, tx, { nonce: Number(nonce), tupleSlot: at.slot, slotAtSend: now.slot, ageAtSend: now.slot !== undefined ? now.slot - at.slot : undefined, rule: id.rule.rule === 1n ? 'one key' : 'two of three', version: id.version, proof }, o.refusable ?? false, o.waitBlocks ?? 0)
}

// ---- identities ----

const seed = (l: string) => fromLabel(l)
const one = (k: string): Rule => ({ rule: 1n, seeds: [seed(k)] })
const twoOfThree = (a: string, b: string, c: string): Rule => ({ rule: 2n, seeds: [seed(a), seed(b), seed(c)] })
const ident = (name: string, rule: Rule): Identity => ({ s: seed(`x33/${name}/s`), version: 0, rule, rec: digestOf(one(`x33/${name}/rec`)), salt: seed(`x33/${name}/salt/0`), recovery: one(`x33/${name}/rec`) })

async function startChain(tag: string, binary: string, predeploy: Hex) {
  const devKey = readFileSync(join(work, 'ethrex/fixtures/keys/private_keys_l1.txt'), 'utf8').split('\n')[0].trim() as Hex
  const skipFile = join(work, `x33-skip-${label}-${tag}`)
  writeFileSync(skipFile, '0')
  process.env.X33_SLOT_SKIP_FILE = skipFile
  const chain = await startLocalChain({
    root, label: `x33-${label}-${tag}`, setting: 'extended', prover: PROVER, programs: join(here, '../32-a-shared-keystore-for-stealth-accounts-in-leanvm/build'),
    alloc: { [RECENT_ROOT.toLowerCase()]: { balance: '0x0', code: predeploy, nonce: '0x1' } }, chainId: 8141, binary,
  })
  console.log(`${tag}: ethrex ${chain.ethrexCommit.slice(0, 8)}, chain ${chain.chainId}, binary ${binary.split('/').pop()}`)
  return new Session(chain, devKey, skipFile)
}

// ---- phase 1: cases (a) to (e) and (g) ----

async function mainRun() {
  const binary = join(work, 'ethrex-bins/ethrex-8288-clock')
  const s = await startChain('main', binary, RECENT_ROOT_CODE)
  record.main = { binary: { file: 'ethrex-8288-clock', sha: sha(binary) }, predeploy: sha256Of(RECENT_ROOT_CODE), patches: { clock: sha(join(here, 'ethrex-clock.patch')) }, rows: s.rows }
  try {
    const store = new Store(s)
    await store.deploy()
    const A = ident('A', one('x33/A/k0'))
    const B = ident('B', twoOfThree('x33/B/k0', 'x33/B/k1', 'x33/B/k2'))
    await store.register('register A (one key)', A)
    await store.register('register B (two of three)', B)
    await store.register('register F (filler)', ident('F', one('x33/F/k0')))
    const accA = await deployAccount(s, store, "deploy A's account", A, 'x33/A/r/0')
    const accB = await deployAccount(s, store, "deploy B's account", B, 'x33/B/r/0')
    record.code = { A: await s.client.getCode({ address: accA.address }), B: await s.client.getCode({ address: accB.address }) }
    const now = () => ({ ks: store.ks, slot: store.last.slot, rho: store.last.rho })

    // (a) and (g): one spend each, reading 2.
    await spend(s, '(a) spend, A, one key', accA, now(), store)
    await spend(s, '(g) spend, B, two of three', accB, now(), store)
    // (e) reading 1: the dependency before the approving VERIFY.
    await spend(s, '(e) reading 1, A', accA, now(), store, { reading: 1, refusable: true, waitBlocks: 8 })
    await spend(s, '(e) reading 2, A', accA, now(), store)

    // (b) a rotation, then a spend at the next version against the new root.
    const before = { ks: store.ks.snapshot(), slot: store.last.slot, rho: store.last.rho }
    const next = { rule: one('x33/A/k0/v1'), rec: A.rec, salt: seed('x33/A/salt/1') }
    await store.rotate('(b) rotate A', A, next)
    const A1: Identity = { ...A, version: 1, rule: next.rule, salt: next.salt }
    accA.id = A1
    await spend(s, '(b) spend, A at version 1', accA, now(), store)

    // (c) the revoked key: the root before the rotation, then the root after it.
    await spend(s, '(c1) revoked key, root before the rotation', accA, before, store, { idOverride: A, refusable: true })

    // (d) no keystore write for 8,191 slots.
    const skip = await s.skipSlots(8191)
    record.skip = skip
    await spend(s, '(d1) spend naming the last root', accA, now(), store, { refusable: true, waitBlocks: 4 })
    await store.refresh('(d2) refresh, by an account not the keystore\'s')
    await spend(s, '(d3) spend naming the refreshed root', accA, now(), store)

    // (c2), last: the revoked key naming the root after the rotation. The prover refuses the
    // statement, so the transaction carries the triple and no proof. It runs last because a smoke run
    // found that the builder then makes no block (it includes the transaction and its block check
    // refuses the missing proof), so nothing can follow it on this chain.
    await spend(s, '(c2) revoked key, root after the rotation, no proof', accA, now(), store, { idOverride: A, noProof: true, refusable: true, waitBlocks: 8 })
  } finally {
    record.main = { ...(record.main as object), builds: s.chain.builds().length, checks: s.chain.checks().slice(-20) }
    save()
    await s.chain.stop()
  }
}

// ---- phase 2: case (f), on the maximum-age binary with the patched predeploy ----

const BOUND = 64n
async function fixRun() {
  const binary = join(work, 'ethrex-bins/ethrex-8288-clock-maxage')
  // The patched predeploy's runtime is the object's own code; ethrex-maxage.patch carries the same bytes.
  const predeploy = compileYul(join(here, 'contracts/RecentRootMaxAge.yul'))
  const s = await startChain('fix', binary, predeploy)
  record.fix = { binary: { file: 'ethrex-8288-clock-maxage', sha: sha(binary) }, predeploy: sha256Of(predeploy), predeployBytes: (predeploy.length - 2) / 2, patches: { clock: sha(join(here, 'ethrex-clock.patch')), maxAge: sha(join(here, 'ethrex-maxage.patch')) }, bound: BOUND, rows: s.rows }
  try {
    const store = new Store(s)
    await store.deploy()
    const A = ident('A', one('x33/A/k0'))
    await store.register('fix: register A', A)
    const accU = await deployAccount(s, store, "fix: deploy A's unbounded account", A, 'x33/A/r/fix-u')
    const accF = await deployAccount(s, store, "fix: deploy A's bounded account", A, 'x33/A/r/fix-f', BOUND)
    const now = () => ({ ks: store.ks, slot: store.last.slot, rho: store.last.rho })
    // The two forms side by side, for the field's cost.
    await spend(s, '(f) cost: unbounded account, 72-byte form', accU, now(), store)
    await spend(s, '(f3) honest spend, bounded account, maximum-age form', accF, now(), store, { maxAge: BOUND })
    // A rotation, then the revoked key against the root from before it.
    const before = { ks: store.ks.snapshot(), slot: store.last.slot, rho: store.last.rho }
    const next = { rule: one('x33/A/k0/v1'), rec: A.rec, salt: seed('x33/A/salt/1') }
    await store.rotate('fix: rotate A', A, next)
    const A1: Identity = { ...A, version: 1, rule: next.rule, salt: next.salt }
    await spend(s, '(f1) revoked key, root younger than the bound', accF, before, store, { idOverride: A, maxAge: BOUND, refusable: true })
    const skip = await s.skipSlots(Number(BOUND) + 36)
    ;(record.fix as Row).skip = skip
    await spend(s, '(f2a) revoked key, root older than the bound, max_age = bound', accF, before, store, { idOverride: A, maxAge: BOUND, refusable: true, waitBlocks: 4 })
    await spend(s, '(f2b) revoked key, root older than the bound, max_age = 8191', accF, before, store, { idOverride: A, maxAge: 8191n, refusable: true, waitBlocks: 4 })
    await spend(s, '(f2c) revoked key, same root, unbounded account, 72-byte form', accU, before, store, { idOverride: A, refusable: true })
    await store.refresh('fix: refresh')
    accF.id = A1
    await spend(s, '(f3b) honest spend at version 1, bounded account, refreshed root', accF, now(), store, { maxAge: BOUND })
  } finally {
    record.fix = { ...(record.fix as object), builds: s.chain.builds().length }
    save()
    await s.chain.stop()
  }
}

function sha256Of(h: Hex) { return bytesToHex(keccak_256(Buffer.from(h.slice(2), 'hex'))) }

if (phase === 'main' || phase === 'both') await mainRun()
if (phase === 'fix' || phase === 'both') await fixRun()
save()
console.log(`wrote ${out}`)
