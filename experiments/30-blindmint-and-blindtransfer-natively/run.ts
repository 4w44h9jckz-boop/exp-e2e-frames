// Experiment 30: BLINDMINT, BLINDTRANSFER and BLINDPRUNE, natively, on the local chain.
//
// Usage (from the repository root, after scripts/ethrex-blind.sh):
//   npx tsx experiments/30-blindmint-and-blindtransfer-natively/run.ts <n>-<label>
// The semantics are SPEC.md's; the cases and predictions are the README's.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bls12_381 as bls } from '@noble/curves/bls12-381'
import { type Address, type Hex, concatHex, createWalletClient, defineChain, hexToBytes, http, keccak256, numberToHex, pad, serializeSignature, toHex } from 'viem'
import { privateKeyToAccount, privateKeyToAddress, sign } from 'viem/accounts'
import { run, startLocalChain } from '../../src/e2e/index.js'
import * as L from '../19-x14-hash-based-stealth-addresses-under-8288/lean.js'

const root = new URL('../../', import.meta.url).pathname
const here = new URL('.', import.meta.url).pathname
const label = process.argv[2]
if (!label || !/^\d+-[a-z0-9-]+$/.test(label)) throw new Error('usage: run.ts <n>-<label>')
delete process.env.PRIVATE_KEY
const BINARY = join(root, 'work/ethrex-bins/ethrex-8288-writes-blind')

// SPEC.md's constants
const BLINDMINT = '0x0000000000000000000000000000000000000b11' as Address
const BLINDTRANSFER = '0x0000000000000000000000000000000000000b12' as Address
const BLINDPRUNE = '0x0000000000000000000000000000000000000b13' as Address
const ESCROW = BLINDMINT
const DST = 'BLIND_V1_BLS12381G1_XMD:SHA-256_SSWU_RO_'
const PAYOUT_TAG = toHex('BLIND_PAYOUT_V1')
const SERIALS_TAG = toHex('BLIND_SERIALS')
const D = 10n ** 16n
const ORDER = bls.params.r

// Keys and addresses from public labels: test keys, not post-quantum.
const k = (l: string) => keccak256(toHex(`exp30/${l}`))
const addr = (l: string) => privateKeyToAddress(k(l))
const scalar = (l: string) => (BigInt(k(l)) % (ORDER - 1n)) + 1n
const word = (n: bigint | number) => pad(numberToHex(BigInt(n)), { size: 32 })

// The issuer: one BLS12-381 key, signatures in G1, the key in G2.
const sk = scalar('issuer')
const pkPoint = bls.G2.ProjectivePoint.BASE.multiply(sk)
const PK = toHex(pkPoint.toRawBytes(false))
const H = (m: Hex) => bls.G1.hashToCurve(hexToBytes(m), { DST }) as unknown as InstanceType<typeof bls.G1.ProjectivePoint>
let blinds = 0
function issue(m: Hex) {
  // The buyer blinds, the issuer signs what it sees, the buyer unblinds.
  const r = (BigInt(`0x${createHash('sha256').update(`blind/${m}/${blinds++}/${Date.now()}`).digest('hex')}`) % (ORDER - 1n)) + 1n
  const seen = H(m).multiply(r)
  const signed = seen.multiply(sk)
  const sigma = signed.multiply(modInverse(r, ORDER))
  if (!bls.fields.Fp12.eql(bls.pairing(sigma, bls.G2.ProjectivePoint.BASE), bls.pairing(H(m), pkPoint))) throw new Error('the issuer signed badly')
  return sigma
}
function modInverse(a: bigint, m: bigint) {
  let [r0, r1, s0, s1] = [a % m, m, 1n, 0n]
  while (r1 !== 0n) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1] }
  return ((s0 % m) + m) % m
}

const chiOf = (end: bigint) => keccak256(concatHex([PK, word(D), word(end)]))
const head = (end: bigint) => concatHex([PK, word(D), word(end)])
const countSlot = (chi: Hex, i: number) => keccak256(concatHex([chi, word(i)]))
const serialsOf = (chi: Hex) => `0x${keccak256(concatHex([SERIALS_TAG, chi])).slice(26)}` as Address

type Ticket = { chi: Hex; serial: Hex; otkKey: Hex; otk: Address; sigma: ReturnType<typeof issue> }
function ticket(chi: Hex, l: string, opts: { forged?: boolean; otkLabel?: string } = {}): Ticket {
  const serial = k(`serial/${l}`)
  const otkKey = k(`otk/${opts.otkLabel ?? l}`)
  const otk = privateKeyToAddress(otkKey)
  const m = concatHex([chi, serial, otk])
  const sigma = opts.forged ? bls.G1.ProjectivePoint.BASE.multiply(scalar(`forged/${l}`)) : issue(m)
  return { chi, serial, otkKey, otk, sigma }
}

let chainId = 0n
async function entry(t: Ticket, recipient: Address, signedFor?: Address) {
  const digest = keccak256(concatHex([PAYOUT_TAG, word(chainId), t.chi, t.serial, signedFor ?? recipient]))
  const sig = serializeSignature(await sign({ hash: digest, privateKey: t.otkKey }))
  return concatHex([t.serial, t.otk, recipient, sig])
}
async function transferData(end: bigint, tickets: Ticket[], recipients: Address[], signedFor: (Address | undefined)[] = []) {
  const agg = tickets.slice(1).reduce((s, t) => s.add(t.sigma), tickets[0].sigma)
  const entries = await Promise.all(tickets.map((t, i) => entry(t, recipients[i], signedFor[i])))
  return concatHex([head(end), toHex(agg.toRawBytes(false)), word(tickets.length), ...entries])
}
const mintData = (end: bigint, n: number) => concatHex([head(end), word(n)])
const pruneData = (end: bigint) => head(end)
const calldataGas = (data: Hex) => {
  const b = hexToBytes(data)
  const zeros = b.filter((x) => x === 0).length
  return 21_000 + 4 * zeros + 16 * (b.length - zeros)
}
// SPEC.md's schedule
const expectTransfer = (n: number, newSerials: boolean, empty: number) => 1_100 + 102_900 + 5_000 + 45_950 * n + (newSerials ? 25_000 : 0) + 25_000 * empty

// Accounts
const buyer = 'buyer'
const payers = ['payer1', 'payer2', 'payer3']
const attacker = 'attacker'
const existing = [0, 1, 2, 3].map((i) => addr(`existing/${i}`))
const REVERTER = '0x00000000000000000000000000000000000057e3' as Address
const alloc: Record<string, { balance: string; code?: Hex }> = {}
for (const l of [buyer, ...payers, attacker]) alloc[addr(l)] = { balance: numberToHex(10n ** 21n) }
for (const a of existing) alloc[a] = { balance: '0x1' }
alloc[REVERTER] = { balance: '0x0', code: '0x60006000fd' } // PUSH1 0 PUSH1 0 REVERT

const binarySha = createHash('sha256').update(readFileSync(BINARY)).digest('hex')
const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
const programs = join(root, 'experiments/19-x14-hash-based-stealth-addresses-under-8288/programs')
const chain = await startLocalChain({ root, label: `e30-${label}`, setting: 'written', chainId: 8141, prover: L.PROVER, programs, alloc, binary: BINARY })
chainId = chain.chainId
const local = defineChain({ id: Number(chainId), name: 'exp30 local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [chain.url] } } })
const wallets = Object.fromEntries([buyer, ...payers, attacker].map((l) => [l, createWalletClient({ account: privateKeyToAccount(k(l)), chain: local, transport: http(chain.url) })]))
const c = chain.client
const rpc = async (method: string, params: unknown[]) => {
  const r = await fetch(chain.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const b = (await r.json()) as { result?: any; error?: { message: string } }
  if (b.error) throw new Error(`${method}: ${b.error.message}`)
  return b.result
}
const counts = async (chi: Hex) => ({
  burned: BigInt(await rpc('eth_getStorageAt', [ESCROW, countSlot(chi, 0), 'latest'])),
  minted: BigInt(await rpc('eth_getStorageAt', [ESCROW, countSlot(chi, 1), 'latest'])),
  pruned: BigInt(await rpc('eth_getStorageAt', [ESCROW, countSlot(chi, 2), 'latest'])),
})
const balance = async (a: Address) => (await c.getBalance({ address: a })).toString()
const spent = async (chi: Hex, serial: Hex) => BigInt(await rpc('eth_getStorageAt', [serialsOf(chi), serial, 'latest']))
const str = (o: Record<string, bigint>) => Object.fromEntries(Object.entries(o).map(([a, b]) => [a, b.toString()]))

async function sign1559(from: string, to: Address, data: Hex, value = 0n, gas = 3_000_000n) {
  const w = wallets[from]
  const request = await w.prepareTransactionRequest({ to, data, value, gas })
  return w.signTransaction(request as any)
}
async function send(from: string, to: Address, data: Hex, value = 0n, gas = 3_000_000n) {
  const raw = await sign1559(from, to, data, value, gas)
  const hash = await c.sendRawTransaction({ serializedTransaction: raw })
  const r = await c.waitForTransactionReceipt({ hash, timeout: 120_000 })
  const intrinsic = calldataGas(data)
  return { hash, status: r.status === 'success' ? 1 : 0, block: Number(r.blockNumber), gasUsed: Number(r.gasUsed), gasLimit: Number(gas), intrinsicAndCalldata: intrinsic, precompile: Number(r.gasUsed) - intrinsic }
}

const out: any = { label, repoCommit, ethrex: chain.ethrexCommit, binary: { path: 'work/ethrex-bins/ethrex-8288-writes-blind', sha256: binarySha }, chainId: Number(chainId), D: D.toString(), issuerKey: PK, cases: [] as any[], batches: [] as any[] }
const record = (x: any) => { out.cases.push(x); console.log(`${x.case}: ${x.tx ? `status ${x.tx.status}, block ${x.tx.block}, gas ${x.tx.gasUsed}` : JSON.stringify(x.outcome ?? '')}`) }

try {
  const start = await c.getBlockNumber()
  const end1 = start + 1_000_000n
  const chi1 = chiOf(end1)
  out.chi1 = { chi: chi1, end: end1.toString(), serials: serialsOf(chi1) }

  // chi1: four purchases for the cases
  const m1 = await send(buyer, BLINDMINT, mintData(end1, 4), 4n * D, 200_000n)
  record({ case: 'setup: mint 4 under chi1', tx: m1, counts: str(await counts(chi1)), escrow: await balance(ESCROW) })

  async function payout(name: string, from: string, end: bigint, chi: Hex, ts: Ticket[], rs: Address[], extra: any = {}, signedFor: (Address | undefined)[] = []) {
    const before = { counts: str(await counts(chi)), escrow: await balance(ESCROW), recipients: await Promise.all(rs.map(balance)) }
    const data = await transferData(end, ts, rs, signedFor)
    const tx = await send(from, BLINDTRANSFER, data)
    const after = { counts: str(await counts(chi)), escrow: await balance(ESCROW), recipients: await Promise.all(rs.map(balance)), spent: await Promise.all(ts.map((t) => spent(chi, t.serial).then(String))) }
    const x = { case: name, n: ts.length, tx, before, after, ...extra }
    record(x)
    return x
  }

  // (a) an honest payout; the first under chi1 also creates its serial account
  const fresh = (l: string) => addr(`fresh/${l}`)
  const tA = ticket(chi1, 'a')
  const a = await payout('(a) honest payout', 'payer1', end1, chi1, [tA], [fresh('a')], { expectedPrecompile: expectTransfer(1, true, 1) })
  // (b) the same ticket again; then one serial twice in a batch
  await payout('(b1) the same ticket again', 'payer1', end1, chi1, [tA], [fresh('b1')])
  const tB = ticket(chi1, 'b2')
  await payout('(b2) one serial twice in a batch', 'payer1', end1, chi1, [tB, tB], [fresh('b2x'), fresh('b2y')])
  // (c') a forged signature, while purchases remain
  await payout("(c') a forged signature", 'payer1', end1, chi1, [ticket(chi1, 'cprime', { forged: true })], [fresh('cprime')])
  // (e) a recipient whose code reverts on any call
  await payout('(e) a recipient that reverts', 'payer1', end1, chi1, [ticket(chi1, 'e')], [REVERTER], { expectedPrecompile: expectTransfer(1, false, 0) })
  // (f) a redirected copy: the recipient changed with the signature kept; the one-time key swapped; then the original
  const tF = ticket(chi1, 'f')
  await payout('(f1) a copy redirected, the signature kept', 'attacker', end1, chi1, [tF], [addr(attacker)], {}, [fresh('f')])
  const tF2 = { ...tF, otkKey: k('otk/attacker'), otk: privateKeyToAddress(k('otk/attacker')) }
  await payout("(f2) a copy under the attacker's one-time key", 'attacker', end1, chi1, [tF2], [addr(attacker)])
  await payout('(f) the original, after both copies', 'payer1', end1, chi1, [tF], [fresh('f')], { expectedPrecompile: expectTransfer(1, false, 1) })

  // (d) two payouts in one block with one purchase left, up to three attempts
  const dAttempts: any[] = []
  for (let attempt = 1; attempt <= 3; attempt++) {
    const cnt = await counts(chi1)
    if (cnt.burned - cnt.minted !== 1n) {
      const need = 1n - (cnt.burned - cnt.minted)
      if (need > 0n) record({ case: `(d) setup: mint ${need} for attempt ${attempt}`, tx: await send(buyer, BLINDMINT, mintData(end1, Number(need)), need * D, 200_000n) })
    }
    const t1 = ticket(chi1, `d${attempt}x`)
    const t2 = ticket(chi1, `d${attempt}y`)
    const [raw1, raw2] = await Promise.all([
      transferData(end1, [t1], [fresh(`d${attempt}x`)]).then((d) => sign1559('payer2', BLINDTRANSFER, d)),
      transferData(end1, [t2], [fresh(`d${attempt}y`)]).then((d) => sign1559('payer3', BLINDTRANSFER, d)),
    ])
    const hashes = await Promise.all([raw1, raw2].map((r) => c.sendRawTransaction({ serializedTransaction: r })))
    const rcs = await Promise.all(hashes.map((hash) => c.waitForTransactionReceipt({ hash, timeout: 120_000 })))
    const res = rcs.map((r) => ({ hash: r.transactionHash, status: r.status === 'success' ? 1 : 0, block: Number(r.blockNumber), gasUsed: Number(r.gasUsed) }))
    const after = str(await counts(chi1))
    dAttempts.push({ attempt, txs: res, counts: after, sameBlock: res[0].block === res[1].block })
    console.log(`(d) attempt ${attempt}: blocks ${res.map((r) => r.block)}, statuses ${res.map((r) => r.status)}`)
    if (res[0].block === res[1].block) break
  }
  record({ case: '(d) two payouts in one block, one purchase left', attempts: dAttempts })
  // (c) a ticket the issuer signed with no purchase behind it, now that minted = burned
  const cBefore = await counts(chi1)
  await payout('(c) a ticket signed with no purchase behind it', 'payer1', end1, chi1, [ticket(chi1, 'c')], [fresh('c')], { countsAtSend: str(cBefore) })

  // (g) batches under chi1
  const sizes = [1, 2, 3, 4, 8, 16]
  const plan = [...sizes.map((n) => ({ n, existingRecipients: false })), { n: 1, existingRecipients: true }, { n: 4, existingRecipients: true }]
  const total = plan.reduce((s, p) => s + p.n, 0)
  record({ case: `(g) setup: mint ${total} under chi1`, tx: await send(buyer, BLINDMINT, mintData(end1, total), BigInt(total) * D, 200_000n) })
  for (const p of plan) {
    const ts = Array.from({ length: p.n }, (_, i) => ticket(chi1, `g${p.n}${p.existingRecipients ? 'e' : 'f'}/${i}`))
    const rs = ts.map((_, i) => (p.existingRecipients ? existing[i] : fresh(`g${p.n}/${i}`)))
    const empty = p.existingRecipients ? 0 : p.n
    const x = await payout(`(g) batch of ${p.n}, ${p.existingRecipients ? 'existing' : 'fresh'} recipients`, 'payer1', end1, chi1, ts, rs, { expectedPrecompile: expectTransfer(p.n, false, empty) })
    out.batches.push({ n: p.n, recipients: p.existingRecipients ? 'existing' : 'fresh', status: x.tx.status, gasUsed: x.tx.gasUsed, perPayout: x.tx.gasUsed / p.n, precompile: x.tx.precompile, precompilePerPayout: x.tx.precompile / p.n, expectedPrecompile: x.expectedPrecompile, calldataBytes: (hexToBytes(await transferData(end1, ts, rs)).length) })
  }

  // (h) pruning under chi2, whose epoch ends about 40 blocks after its purchases
  const now = await c.getBlockNumber()
  const end2 = now + 40n
  const chi2 = chiOf(end2)
  out.chi2 = { chi: chi2, end: end2.toString(), serials: serialsOf(chi2) }
  record({ case: '(h) setup: mint 3 under chi2', tx: await send(buyer, BLINDMINT, mintData(end2, 3), 3n * D, 200_000n) })
  const h1 = ticket(chi2, 'h1'), h2 = ticket(chi2, 'h2'), h3 = ticket(chi2, 'h3')
  await payout('(h) setup: pay two tickets under chi2', 'payer1', end2, chi2, [h1, h2], [fresh('h1'), fresh('h2')])
  record({ case: '(h) a prune before the end', tx: await send('payer1', BLINDPRUNE, pruneData(end2), 0n, 200_000n) })
  const before = await Promise.all([h1, h2].map((t) => spent(chi2, t.serial).then(String)))
  while ((await c.getBlockNumber()) <= end2) await new Promise((r) => setTimeout(r, 1000))
  await payout('(h) a payout after the end', 'payer1', end2, chi2, [h3], [fresh('h3')])
  record({ case: '(h) a purchase after the end', tx: await send(buyer, BLINDMINT, mintData(end2, 1), D, 200_000n) })
  const pruneTx = await send('payer1', BLINDPRUNE, pruneData(end2), 0n, 200_000n)
  const proof = await rpc('eth_getProof', [serialsOf(chi2), [h1.serial, h2.serial], 'latest'])
  record({ case: '(h) the prune', tx: pruneTx, spentBefore: before, spentAfter: await Promise.all([h1, h2].map((t) => spent(chi2, t.serial).then(String))), serialAccount: { nonce: proof.nonce, balance: proof.balance, storageHash: proof.storageHash, codeHash: proof.codeHash, storageProof: proof.storageProof.map((p: any) => ({ key: p.key, value: p.value })) }, counts: str(await counts(chi2)) })
  record({ case: '(h) a second prune', tx: await send('payer1', BLINDPRUNE, pruneData(end2), 0n, 200_000n) })
  await payout('(h) a payout after the prune', 'payer1', end2, chi2, [ticket(chi2, 'h4')], [fresh('h4')])

  // (i) the invariant
  const c1 = await counts(chi1), c2 = await counts(chi2)
  const escrow = BigInt(await balance(ESCROW))
  const expected = D * (c1.burned - c1.minted + c2.burned - c2.minted)
  out.invariant = { escrow: escrow.toString(), expected: expected.toString(), holds: escrow === expected, chi1: str(c1), chi2: str(c2) }
  console.log(`(i) escrow ${escrow}, expected ${expected}: ${escrow === expected ? 'holds' : 'BROKEN'}`)
} finally {
  out.nodeLog = readFileSync(join(chain.dir, 'node.log'), 'utf8').split('\n').filter((l) => l.startsWith('blind:'))
  await chain.stop()
  mkdirSync(join(here, 'results'), { recursive: true })
  const file = join(here, 'results', `${label}.json`)
  writeFileSync(file, `${JSON.stringify(out, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 1)}\n`)
  console.log(`wrote ${file}`)
}
