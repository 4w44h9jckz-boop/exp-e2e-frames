// What does Ethereum mainnet's execution gas pay for, by function? Reads a sample of blocks (their
// transactions, receipts and call traces) from one public provider, puts each transaction in one
// class (classes.ts), and sums the gas charged inside precompiles from the traces. The record is
// written to results/<date>-head-<head>.json. Passing the head of an earlier record rereads the
// same blocks.
//
// usage: npx tsx measurements/gas-by-function/run.ts [blocks=200] [span=50400] [head=latest]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hexToNumber, rpc } from '../../src/e2e/rpc.js'
import { run } from '../../src/e2e/sh.js'
import { CLASSES, EVENTS, type Frame, KIND, classify, precompileGas } from './classes.js'

const PROVIDER = 'https://eth.drpc.org'
const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const [n, span] = [Number(process.argv[2] ?? 200), Number(process.argv[3] ?? 50400)]
const head = process.argv[4] ? Number(process.argv[4]) : hexToNumber(await rpc('eth_blockNumber', [], PROVIDER))
const commit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
const dirty = (await run('git', ['status', '--porcelain', '--', 'measurements/gas-by-function'], { cwd: root })).trim()
if (dirty) throw new Error(`commit the measurement before a recorded run:\n${dirty}`)
mkdirSync(join(here, 'results'), { recursive: true })

const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v)
const blocks = Array.from({ length: n }, (_, i) => head - span + 1 + Math.floor((i * span) / n))
const gas = new Map<string, number>(), count = new Map<string, number>(), hits = new Map<string, number>()
const preGas = new Map<string, number>(), preByClass = new Map<string, Map<string, number>>()
const otherTo = new Map<string, number>(), otherSel = new Map<string, number>()
const errors = new Map<string, number>()
const rows: { block: number; txs: number; gas_used: number; gas_by_class: Record<string, number> }[] = []
let blobGas = 0, totalGas = 0, totalTx = 0, mismatch = 0, retries = 0
const t0 = Date.now()

// The free endpoint times out now and then, so a block gets three attempts before it is left out.
async function readBlock(bn: number) {
  const tag = `0x${bn.toString(16)}`
  for (let attempt = 1; ; attempt++) {
    try {
      return [
        await rpc('eth_getBlockByNumber', [tag, true], PROVIDER),
        await rpc('eth_getBlockReceipts', [tag], PROVIDER),
        await rpc('debug_traceBlockByNumber', [tag, { tracer: 'callTracer' }], PROVIDER),
      ]
    } catch (e) {
      console.log(`  block ${bn}, attempt ${attempt}: ${(e as Error).message.slice(0, 80)}`)
      if (attempt === 3) throw e
      retries += 1
      await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
}

for (const [k, bn] of blocks.entries()) {
  let blk, rcs, tr
  try {
    ;[blk, rcs, tr] = await readBlock(bn)
  } catch (e) {
    add(errors, (e as Error).name, 1)
    continue
  }
  const byHash = new Map<string, any>(rcs.map((r: any) => [r.transactionHash, r])) // eslint-disable-line @typescript-eslint/no-explicit-any
  const traces = new Map<string, Frame>(tr.map((t: any) => [t.txHash, t.result ?? {}])) // eslint-disable-line @typescript-eslint/no-explicit-any
  const bgas = new Map<string, number>()
  for (const tx of blk.transactions) {
    const rc = byHash.get(tx.hash)
    if (!rc) { add(errors, 'missing-receipt', 1); continue }
    const g = hexToNumber(rc.gasUsed)
    const cls = classify(tx, rc, hits)
    add(gas, cls, g); add(count, cls, 1); add(bgas, cls, g)
    totalGas += g; totalTx += 1
    if (rc.blobGasUsed) blobGas += hexToNumber(rc.blobGasUsed)
    if (cls === 'other-call') { add(otherTo, tx.to.toLowerCase(), g); add(otherSel, tx.input.slice(0, 10), g) }
    const t = traces.get(tx.hash)
    if (!t) { add(errors, 'missing-trace', 1); continue }
    if (hexToNumber(t.gasUsed ?? '0x0') !== g) mismatch += 1
    const p = new Map<string, number>()
    precompileGas(t, p)
    if (!preByClass.has(cls)) preByClass.set(cls, new Map())
    for (const [name, v] of p) { add(preGas, name, v); add(preByClass.get(cls)!, name, v) }
  }
  rows.push({ block: bn, txs: blk.transactions.length, gas_used: hexToNumber(blk.gasUsed), gas_by_class: Object.fromEntries(bgas) })
  if (k % 20 === 0) console.log(`  ${k + 1}/${n} block ${bn}: ${blk.transactions.length} txs, ${Math.round((Date.now() - t0) / 1000)} s`)
  await new Promise((r) => setTimeout(r, 200))
}

const share = (x: number) => (totalGas ? Math.round((10000 * x) / totalGas) / 100 : null)
const top = (m: Map<string, number>, k: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k)
const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0)
console.log(`\n${rows.length} blocks of ${n}, ${totalTx} transactions, ${totalGas.toLocaleString('en')} execution gas, ` +
  `${sum(errors)} errors after ${retries} retries, ${mismatch} trace/receipt gas mismatches`)
for (const c of CLASSES) console.log(`  ${c.padEnd(18)} ${String(count.get(c) ?? 0).padStart(7)} txs ${(gas.get(c) ?? 0).toLocaleString('en').padStart(15)} gas ${String(share(gas.get(c) ?? 0)).padStart(6)}%`)
const verifying = [...preGas].filter(([k]) => KIND[k] !== 'copy').reduce((a, [, v]) => a + v, 0)
console.log(`  precompile gas, all but identity: ${verifying.toLocaleString('en')} (${share(verifying)}%)`)
const allSigs = Object.values(EVENTS).flat()
console.log(`  event signatures that matched nothing: ${allSigs.filter((s) => !hits.get(s)).length} of ${allSigs.length}`)

const out = join(here, 'results', `${new Date().toISOString().slice(0, 10)}-head-${head}.json`)
writeFileSync(out, JSON.stringify({
  retrieved: new Date().toISOString(), commit, command: `npx tsx measurements/gas-by-function/run.ts ${n} ${span} ${head}`,
  provider: PROVIDER, head, span_blocks: span, sample_blocks: n, blocks_read: rows.length,
  transactions: totalTx, execution_gas: totalGas, blob_gas: blobGas, classes: CLASSES,
  by_class: Object.fromEntries(CLASSES.map((c) => [c, { txs: count.get(c) ?? 0, gas: gas.get(c) ?? 0, gas_share_pct: share(gas.get(c) ?? 0) }])),
  precompile_gas: Object.fromEntries(preGas), precompile_kind: KIND,
  precompile_gas_by_class: Object.fromEntries([...preByClass].map(([c, m]) => [c, Object.fromEntries(m)])),
  event_signatures: EVENTS, event_hits: Object.fromEntries(allSigs.map((s) => [s, hits.get(s) ?? 0])),
  other_call_top_recipients_by_gas: top(otherTo, 25), other_call_top_selectors_by_gas: top(otherSel, 25),
  errors: Object.fromEntries(errors), retries, trace_receipt_gas_mismatches: mismatch, blocks: rows,
  exclusions: 'classes by event, first match wins, in the documented order; precompile gas is a lower bound on ' +
    'verification gas; execution gas only, blob gas separate; storage writes not separated; one provider, one ' +
    'sample, a spot reading',
}, null, 2) + '\n')
console.log(out)
