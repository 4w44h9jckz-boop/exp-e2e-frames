// Experiment 31, part C: BLINDROLL, the trade of an unspent ticket for a purchase under a later key.
//
// Usage (from the repository root, after scripts/ethrex-blind.sh):
//   npx tsx experiments/31-blind-tickets-by-epoch-and-a-native-trade/run.ts <n>-<label>
// The cases and predictions are the README's part C; the operations are experiment 30's SPEC.md
// and this README's BLINDROLL.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bls12_381 as bls } from '@noble/curves/bls12-381'
import { type Address, type Hex, concatHex, createWalletClient, defineChain, hexToBytes, http, keccak256, numberToHex, pad, recoverAddress, serializeSignature, toHex } from 'viem'
import { privateKeyToAccount, privateKeyToAddress, sign } from 'viem/accounts'
import { run, startLocalChain } from '../../src/e2e/index.js'
import * as L from '../19-x14-hash-based-stealth-addresses-under-8288/lean.js'

const root = new URL('../../', import.meta.url).pathname
const here = new URL('.', import.meta.url).pathname
const label = process.argv[2]
if (!label || !/^\d+-[a-z0-9-]+$/.test(label)) throw new Error('usage: run.ts <n>-<label>')
delete process.env.PRIVATE_KEY
const BINARY = join(root, 'work/ethrex-bins/ethrex-8288-writes-blind')

const BLINDMINT = '0x0000000000000000000000000000000000000b11' as Address
const BLINDTRANSFER = '0x0000000000000000000000000000000000000b12' as Address
const BLINDROLL = '0x0000000000000000000000000000000000000b14' as Address
const ESCROW = BLINDMINT
const DST = 'BLIND_V1_BLS12381G1_XMD:SHA-256_SSWU_RO_'
const PAYOUT_TAG = toHex('BLIND_PAYOUT_V1')
const ROLL_TAG = toHex('BLIND_ROLL_V1')
const D = 10n ** 16n
const MINT_GAS = 500_000n
const ORDER = bls.params.r

const k = (l: string) => keccak256(toHex(`exp31/${l}`))
const addr = (l: string) => privateKeyToAddress(k(l))
const scalar = (l: string) => (BigInt(k(l)) % (ORDER - 1n)) + 1n
const word = (n: bigint | number) => pad(numberToHex(BigInt(n)), { size: 32 })
type P1 = InstanceType<typeof bls.G1.ProjectivePoint>
const H = (m: Hex) => bls.G1.hashToCurve(hexToBytes(m), { DST }) as unknown as P1
function modInverse(a: bigint, m: bigint) {
  let [r0, r1, s0, s1] = [a % m, m, 1n, 0n]
  while (r1 !== 0n) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1] }
  return ((s0 % m) + m) % m
}

// Two issuers: one key for the old epoch, one for the next.
const issuers = ['issuer-old', 'issuer-new'].map((l) => {
  const sk = scalar(l)
  const pk = bls.G2.ProjectivePoint.BASE.multiply(sk)
  return { sk, pk, PK: toHex(pk.toRawBytes(false)) }
})
let blinds = 0
function issue(which: number, m: Hex) {
  const { sk, pk } = issuers[which]
  const r = (BigInt(`0x${createHash('sha256').update(`blind/${m}/${blinds++}/${Date.now()}`).digest('hex')}`) % (ORDER - 1n)) + 1n
  const sigma = H(m).multiply(r).multiply(sk).multiply(modInverse(r, ORDER))
  if (!bls.fields.Fp12.eql(bls.pairing(sigma, bls.G2.ProjectivePoint.BASE), bls.pairing(H(m), pk))) throw new Error('bad issue')
  return sigma
}
const head = (which: number, end: bigint) => concatHex([issuers[which].PK, word(D), word(end)])
const chiOf = (which: number, end: bigint) => keccak256(head(which, end))
const countSlot = (chi: Hex, i: number) => keccak256(concatHex([chi, word(i)]))

type Ticket = { chi: Hex; serial: Hex; otkKey: Hex; otk: Address; sigma: P1 }
function ticket(which: number, chi: Hex, l: string): Ticket {
  const serial = k(`serial/${l}`)
  const otkKey = k(`otk/${l}`)
  const otk = privateKeyToAddress(otkKey)
  return { chi, serial, otkKey, otk, sigma: issue(which, concatHex([chi, serial, otk])) }
}

let chainId = 0n
async function transferData(which: number, end: bigint, ts: Ticket[], recipients: Address[]) {
  const agg = ts.slice(1).reduce((s, t) => s.add(t.sigma), ts[0].sigma)
  const entries = await Promise.all(ts.map(async (t, i) => {
    const digest = keccak256(concatHex([PAYOUT_TAG, word(chainId), t.chi, t.serial, recipients[i]]))
    return concatHex([t.serial, t.otk, recipients[i], serializeSignature(await sign({ hash: digest, privateKey: t.otkKey }))])
  }))
  return concatHex([head(which, end), toHex(agg.toRawBytes(false)), word(ts.length), ...entries])
}
async function rollData(end: bigint, newWhich: number, newEnd: bigint, ts: Ticket[], claimants: Address[], signedFor: (Address | undefined)[] = []) {
  const chiNew = chiOf(newWhich, newEnd)
  const agg = ts.slice(1).reduce((s, t) => s.add(t.sigma), ts[0].sigma)
  const entries = await Promise.all(ts.map(async (t, i) => {
    const digest = keccak256(concatHex([ROLL_TAG, word(chainId), t.chi, t.serial, chiNew, signedFor[i] ?? claimants[i]]))
    return concatHex([t.serial, t.otk, claimants[i], serializeSignature(await sign({ hash: digest, privateKey: t.otkKey }))])
  }))
  return concatHex([head(0, end), issuers[newWhich].PK, word(newEnd), toHex(agg.toRawBytes(false)), word(ts.length), ...entries])
}
const mintData = (which: number, end: bigint, n: number) => concatHex([head(which, end), word(n)])
const expectRoll = (n: number, newSerials: boolean) => 1_100 + 102_900 + 10_000 + 36_950 * n + (newSerials ? 25_000 : 0) + 1_000

const actors = ['buyer', 'holder', 'attacker']
const alloc: Record<string, { balance: string }> = {}
for (const l of actors) alloc[addr(l)] = { balance: numberToHex(10n ** 21n) }

const binarySha = createHash('sha256').update(readFileSync(BINARY)).digest('hex')
const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
const programs = join(root, 'experiments/19-x14-hash-based-stealth-addresses-under-8288/programs')
const chain = await startLocalChain({ root, label: `e31-${label}`, setting: 'written', chainId: 8141, prover: L.PROVER, programs, alloc, binary: BINARY })
chainId = chain.chainId
const local = defineChain({ id: Number(chainId), name: 'exp31 local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [chain.url] } } })
const wallets = Object.fromEntries(actors.map((l) => [l, createWalletClient({ account: privateKeyToAccount(k(l)), chain: local, transport: http(chain.url) })]))
const c = chain.client
const rpc = async (method: string, params: unknown[]) => {
  const r = await fetch(chain.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const b = (await r.json()) as { result?: any; error?: { message: string } }
  if (b.error) throw new Error(`${method}: ${b.error.message}`)
  return b.result
}
const counts = async (chi: Hex) => ({
  burned: BigInt(await rpc('eth_getStorageAt', [ESCROW, countSlot(chi, 0), 'latest'])).toString(),
  minted: BigInt(await rpc('eth_getStorageAt', [ESCROW, countSlot(chi, 1), 'latest'])).toString(),
})
const escrow = async () => (await c.getBalance({ address: ESCROW })).toString()
async function send(from: string, to: Address, data: Hex, value = 0n, gas = 3_000_000n) {
  const w = wallets[from]
  const req = await w.prepareTransactionRequest({ to, data, value, gas })
  const raw = await w.signTransaction(req as any)
  const hash = await c.sendRawTransaction({ serializedTransaction: raw })
  const r = await c.waitForTransactionReceipt({ hash, timeout: 120_000 })
  return { hash, status: r.status === 'success' ? 1 : 0, block: Number(r.blockNumber), gasUsed: Number(r.gasUsed), logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })) }
}

const out: any = { label, repoCommit, ethrex: chain.ethrexCommit, binary: { path: 'work/ethrex-bins/ethrex-8288-writes-blind', sha256: binarySha }, chainId: Number(chainId), D: D.toString(), cases: [] as any[] }
async function step(name: string, from: string, to: Address, data: Hex, value = 0n, gas?: bigint, extra: any = {}) {
  const tx = await send(from, to, data, value, gas)
  const x = { case: name, tx, after: { old: await counts(chiOld), new: await counts(chiNew), escrow: await escrow() }, ...extra }
  out.cases.push(x)
  console.log(`${name}: status ${tx.status}, block ${tx.block}, gas ${tx.gasUsed}; old ${x.after.old.minted}/${x.after.old.burned}, new ${x.after.new.minted}/${x.after.new.burned}, escrow ${x.after.escrow}`)
  return x
}

const start = await c.getBlockNumber()
const endOld = start + 1_000_000n
const endNew = endOld + 1_000_000n
const chiOld = chiOf(0, endOld)
const chiNew = chiOf(1, endNew)
out.keys = { old: { chi: chiOld, end: endOld.toString() }, new: { chi: chiNew, end: endNew.toString() } }
// The new key's issuer serves each claimant once, after reading its trade's log.
const served = new Set<string>()
try {
  await step('setup: buy 2 under the old key', 'buyer', BLINDMINT, mintData(0, endOld, 2), 2n * D, MINT_GAS)
  const t1 = ticket(0, chiOld, 't1')
  const claimant1Key = k('claimant/1')
  const claimant1 = privateKeyToAddress(claimant1Key)

  // (g1) a trade of one ticket, then the new ticket's payout under the new key
  const g1 = await step('(g1) a trade of one ticket', 'holder', BLINDROLL, await rollData(endOld, 1, endNew, [t1], [claimant1]), 0n, undefined, { expectedPrecompile: expectRoll(1, true) })
  const rollLogs = g1.tx.logs.filter((l: any) => l.address.toLowerCase() === BLINDROLL.toLowerCase())
  // The claimant asks the new issuer for a ticket: it signs a request; the issuer checks the log and its own ledger.
  const tNewSerial = k('serial/new1')
  const tNewOtkKey = k('otk/new1')
  const tNewOtk = privateKeyToAddress(tNewOtkKey)
  const request = keccak256(concatHex([toHex('BLIND_CLAIM_V1'), chiNew, claimant1]))
  const requestSig = serializeSignature(await sign({ hash: request, privateKey: claimant1Key }))
  const seenClaimant = rollLogs.some((l: any) => l.topics[2]?.toLowerCase() === chiNew.toLowerCase() && `0x${l.data.slice(26)}`.toLowerCase() === claimant1.toLowerCase())
  const signer = await recoverAddress({ hash: request, signature: requestSig })
  const servedOk = seenClaimant && signer.toLowerCase() === claimant1.toLowerCase() && !served.has(claimant1.toLowerCase())
  if (servedOk) served.add(claimant1.toLowerCase())
  const tNew: Ticket = { chi: chiNew, serial: tNewSerial, otkKey: tNewOtkKey, otk: tNewOtk, sigma: issue(1, concatHex([chiNew, tNewSerial, tNewOtk])) }
  const servedAgain = !served.has(claimant1.toLowerCase())
  out.claim = { logSeen: seenClaimant, signer, served: servedOk, servedTwice: servedAgain }
  console.log(`claim: log seen ${seenClaimant}, served ${servedOk}, a second request served ${servedAgain}`)
  const recipient = addr('recipient/new1')
  await step('(g1) the new ticket paid out under the new key', 'holder', BLINDTRANSFER, await transferData(1, endNew, [tNew], [recipient]), 0n, undefined, { recipientBalance: (await c.getBalance({ address: recipient })).toString() })
  out.recipientAfter = (await c.getBalance({ address: recipient })).toString()

  // (g2) the old ticket again: as a payout and as a trade
  await step('(g2) the old ticket again, as a payout', 'holder', BLINDTRANSFER, await transferData(0, endOld, [t1], [addr('recipient/again')]))
  await step('(g2) the old ticket again, as a trade', 'holder', BLINDROLL, await rollData(endOld, 1, endNew, [t1], [addr('claimant/again')]))

  // (g3) a trade to an earlier key (the denomination cannot differ: the trade inherits it)
  const t2 = ticket(0, chiOld, 't2')
  await step('(g3) a trade to an earlier key', 'holder', BLINDROLL, await rollData(endOld, 1, endOld - 1n, [t2], [addr('claimant/earlier')]))
  // (g4) a trade whose one-time key signed another claimant
  await step('(g4) a trade naming a claimant the one-time key did not sign', 'attacker', BLINDROLL, await rollData(endOld, 1, endNew, [t2], [addr('attacker')], [addr('claimant/2')]))
  // the second purchase, traded validly; then (g5) with no purchase left
  await step('(g5) setup: the second ticket traded', 'holder', BLINDROLL, await rollData(endOld, 1, endNew, [t2], [addr('claimant/2')]), 0n, undefined, { expectedPrecompile: expectRoll(1, false) })
  await step('(g5) a trade with no purchase left', 'holder', BLINDROLL, await rollData(endOld, 1, endNew, [ticket(0, chiOld, 't3')], [addr('claimant/3')]))

  // (g6) the invariant
  const o = await counts(chiOld), n = await counts(chiNew)
  const e = BigInt(await escrow())
  const expected = D * (BigInt(o.burned) - BigInt(o.minted) + BigInt(n.burned) - BigInt(n.minted))
  out.invariant = { escrow: e.toString(), expected: expected.toString(), holds: e === expected, old: o, new: n }
  console.log(`(g6) escrow ${e}, expected ${expected}: ${e === expected ? 'holds' : 'BROKEN'}`)
} finally {
  out.nodeLog = readFileSync(join(chain.dir, 'node.log'), 'utf8').split('\n').filter((l) => l.startsWith('blind:'))
  await chain.stop()
  mkdirSync(join(here, 'results'), { recursive: true })
  const file = join(here, 'results', `${label}.json`)
  writeFileSync(file, `${JSON.stringify(out, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 1)}\n`)
  console.log(`wrote ${file}`)
}
