// Experiment 19 (X14), after run 2, not pre-registered: the recorded transactions against
// rapidblocks' conflict rule (ethresear.ch topics 26152 and 26157, read 2026-11-04). There, a
// transaction is blocked from the fast path if it touches a key a concurrent earlier block
// modified, keys being per storage slot and per account field (balance, nonce, code), and balance
// credits that nothing in the transaction reads not counting as touches.
//
// For each transaction in run 2's test-network records, this reads the block's EIP-7928 access list
// from the test network and keeps the entries at the transaction's index: the storage slots, nonces
// and code it wrote, and each balance it changed, as a debit or a credit. Two transactions of one
// kind would conflict on every key both write, credits aside. That is a lower bound: the access list
// records reads per block, not per transaction, so a key one reads and the other writes is not seen.
// The payer of payments and deposits (one funder here, a different one each in practice) is set
// aside; a frame transaction's own sender, such as a pool paying for its withdrawal, is not.
//
// usage: npx tsx experiments/19-x14-hash-based-stealth-addresses-under-8288/conflicts.ts <n>-<label> [record ...]
//        (records default to run 2's test-network ones; every pair of each kind is compared)
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Address, Hex } from 'viem'
import { makeClient } from '../../src/exp-frames/frametx/index.js'

const here = new URL('.', import.meta.url).pathname
const runLabel = process.argv[2]
if (!runLabel) throw new Error('usage: conflicts.ts <n>-<label>')
const chain = makeClient()
const RECORDS = process.argv.length > 3 ? process.argv.slice(3) : ['2-part2-testnet', '2-part2-testnet-v2a', '2-part3-testnet-v2b']

type Bal = { address: Address; balanceChanges: { index: Hex; postBalance?: Hex; value?: Hex }[]; nonceChanges: { index: Hex }[]; codeChanges: { index: Hex }[]; storageChanges: { key: Hex; changes: { index: Hex }[] }[] }
const balCache = new Map<number, Bal[]>()
async function bal(block: number) {
  if (!balCache.has(block)) balCache.set(block, (await chain.request({ method: 'eth_getBlockAccessList', params: [`0x${block.toString(16)}`] } as never)) as Bal[])
  return balCache.get(block)!
}
const big = (h?: Hex) => (h ? BigInt(h) : 0n)

async function balanceBefore(address: Address, block: number, idx: number, first: number): Promise<bigint> {
  const at = (b: Bal[] | undefined, below: number) => b?.find((e) => e.address.toLowerCase() === address.toLowerCase())?.balanceChanges.filter((c) => Number(c.index) < below).sort((x, y) => Number(y.index) - Number(x.index))[0]
  const here = at(await bal(block), idx)
  if (here) return big(here.postBalance ?? here.value)
  for (let b = block - 1; b >= first; b--) {
    const c = at(await bal(b), Number.MAX_SAFE_INTEGER)
    if (c) return big(c.postBalance ?? c.value)
  }
  return 0n
}
const names = new Map<string, string>()
const funders = new Set<string>()
const name = (a: string) => names.get(a.toLowerCase()) ?? 'a fresh account'
const out: Record<string, unknown>[] = []
for (const f of RECORDS) {
  const r = JSON.parse(readFileSync(join(here, 'results', `${f}.json`), 'utf8'))
  for (const [k, v] of Object.entries(r.contracts ?? {})) {
    if (Array.isArray(v)) v.forEach((x, i) => names.set(String(x).toLowerCase(), `${k.replace(/s$/, '')} ${i}`))
    else names.set(String(v).toLowerCase(), k)
  }
  names.set('0x0000000000000000000000000000000000008272', 'EIP-8272 recent roots')
  names.set(String(r.funder).toLowerCase(), 'the funder (payer of payments and deposits)')
  funders.add(String(r.funder).toLowerCase())
  names.set('0x0000000000000000000000000000000000008250', 'EIP-8250 nonce keys')
  const first = Number(r.blocks.first)
  for (const row of r.rows as { step: string; hash?: Hex; block?: number }[]) {
    if (!row.hash || !row.block) continue
    const rc = await chain.getTransactionReceipt({ hash: row.hash })
    const idx = rc.transactionIndex + 1 // EIP-7928: index 0 is the block's pre-execution system calls
    const entries = await bal(row.block)
    const miner = (await chain.getBlock({ blockNumber: BigInt(row.block) })).miner.toLowerCase()
    const writes: { key: string; what: string }[] = []
    for (const e of entries) {
      const a = e.address.toLowerCase()
      for (const s of e.storageChanges) if (s.changes.some((c) => Number(c.index) === idx)) writes.push({ key: `${a}:slot:${s.key}`, what: `${name(a)}, storage ${s.key.slice(0, 10)}...` })
      if (e.nonceChanges.some((c) => Number(c.index) === idx)) writes.push({ key: `${a}:nonce`, what: `${name(a)}, nonce` })
      if (e.codeChanges.some((c) => Number(c.index) === idx)) writes.push({ key: `${a}:code`, what: `${name(a)}, code` })
      const bc = e.balanceChanges.find((c) => Number(c.index) === idx)
      if (bc) {
        // The test network serves no historical state (eth_getBalance answers the latest balance for
        // every block), so the balance before comes from the access lists themselves: the latest
        // earlier change in this block, or in the run's earlier blocks; an account with none was
        // empty before the run. The sender pays gas and the fee recipient is paid, whatever else.
        const debit = a === rc.from.toLowerCase() ? true : a === miner ? false : big(bc.postBalance ?? bc.value) < (await balanceBefore(e.address, row.block, idx, first))
        writes.push({ key: `${a}:balance:${debit ? 'debit' : 'credit'}`, what: `${name(a)}, balance ${debit ? 'debit' : 'credit'}` })
      }
    }
    out.push({ record: f, step: row.step, hash: row.hash, block: row.block, index: rc.transactionIndex, sender: rc.from, writes })
    console.log(`${row.step}: ${writes.map((w) => w.what).join('; ')}`)
  }
}

// Kinds: a version and what the transaction does, so that the owner's spend and a delegated
// prover's, or two accounts' payments, are one kind.
const kindOf = (s: string) => {
  const v = s.split(':')[0]
  const what = /pay and announce/.test(s) ? 'payment' : /: pay, /.test(s) ? 'payment (creation)' : /: announce, /.test(s) ? 'announcement' : /deposit/.test(s) ? 'deposit' : /withdraw/.test(s) ? 'withdrawal' : /spend/.test(s) ? 'spend' : s
  return `${v}: ${what}`
}
const kinds = new Map<string, typeof out>()
for (const t of out) {
  const k = kindOf(t.step as string)
  kinds.set(k, [...(kinds.get(k) ?? []), t])
}
// The funder, which pays for every payment and deposit here, stands in for one payer each, so its
// own nonce and balance are set aside. A frame transaction's sender is not: when it is the pool
// itself, paying gas and the withdrawal from its own balance, that balance is the shared key.
const touches = (t: Record<string, unknown>) => new Set((t.writes as { key: string }[]).map((w) => w.key).filter((k) => !k.endsWith(':credit') && !funders.has(k.split(':')[0])))
const conflicts: Record<string, unknown>[] = []
for (const [k, ts] of kinds) {
  for (let a = 0; a < ts.length; a++) {
    for (let b = a + 1; b < ts.length; b++) {
      const [x, y] = [touches(ts[a]), touches(ts[b])]
      const shared = [...x].filter((key) => y.has(key))
      const label = (key: string) => (ts[a].writes as { key: string; what: string }[]).find((w) => w.key === key)?.what ?? key
      conflicts.push({ kind: k, pair: [ts[a].step, ts[b].step], sharedWrites: shared.map(label), conflict: shared.length > 0 })
      console.log(`${k} | ${ts[a].step} | ${ts[b].step}: ${shared.length ? `conflict on ${shared.map(label).join('; ')}` : 'independent'}`)
    }
  }
}
writeFileSync(join(here, 'results', `${runLabel}.json`), JSON.stringify({ experiment: 19, run: runLabel, rule: 'rapidblocks, topics 26152 and 26157: per storage slot and account field; balance credits not counted', records: RECORDS, transactions: out, conflicts }, null, 2) + '\n')
console.log(`recorded results/${runLabel}.json`)
process.exit(0)
