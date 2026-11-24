// Experiment 25 (X18), arm 0: every transaction a chain holds, with its gas, read back from the
// chain itself after a reproduction. Function names are resolved from the method identifiers of
// INTMAX3's own forge build in work/, so a selector that names no INTMAX3 function stays a selector.
// Nothing here reads a key.
//
// usage: npx tsx experiments/25-x18-intmax3-withdrawals-as-l1-5-jobs/chainlog.ts <rpc> <n>-<label>

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPublicClient, http, type Hex } from 'viem'

const pin = '979318dbf48eee360235fab9b5675b82e8cfde12'
const here = new URL('.', import.meta.url).pathname
const root = join(here, '../..')

function selectors(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const dir = join(root, 'work', `intmax3-${pin.slice(0, 12)}`, 'contracts', 'out')
  for (const sub of readdirSync(dir)) {
    let files: string[] = []
    try { files = readdirSync(join(dir, sub)) } catch { continue }
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      let ids: Record<string, string> | undefined
      try { ids = JSON.parse(readFileSync(join(dir, sub, f), 'utf8')).methodIdentifiers } catch { continue }
      for (const [sig, id] of Object.entries(ids ?? {})) {
        const k = `0x${id}`
        const name = `${f.replace(/\.json$/, '')}.${sig}`
        const seen = out.get(k) ?? []
        if (!seen.includes(name)) seen.push(name)
        // INTMAX3's deployed contracts first; test harnesses that share a selector after them.
        seen.sort((a, b) => Number(/Harness|Mock|Test/.test(a)) - Number(/Harness|Mock|Test/.test(b)))
        out.set(k, seen)
      }
    }
  }
  return out
}

async function main() {
  const [rpc, label] = process.argv.slice(2)
  if (!rpc || !label) throw new Error('usage: chainlog.ts <rpc> <n>-<label>')
  const client = createPublicClient({ transport: http(rpc) })
  const names = selectors()
  const chainId = await client.getChainId()
  const head = await client.getBlockNumber()
  const txs: unknown[] = []
  for (let n = 0n; n <= head; n++) {
    const block = await client.getBlock({ blockNumber: n, includeTransactions: true })
    for (const tx of block.transactions) {
      const r = await client.getTransactionReceipt({ hash: tx.hash })
      const selector = tx.input.length >= 10 ? (tx.input.slice(0, 10) as Hex) : null
      txs.push({
        block: Number(n),
        hash: tx.hash,
        from: tx.from,
        to: tx.to,
        type: tx.type,
        created: r.contractAddress ?? null,
        selector,
        function: selector && tx.to ? (names.get(selector) ?? null) : null,
        inputBytes: (tx.input.length - 2) / 2,
        blobs: tx.blobVersionedHashes?.length ?? 0,
        gasLimit: Number(tx.gas),
        gasUsed: Number(r.gasUsed),
        blobGasUsed: r.blobGasUsed !== undefined ? Number(r.blobGasUsed) : 0,
        status: r.status,
      })
    }
  }
  const out = join(here, 'results', `${label}.json`)
  writeFileSync(out, `${JSON.stringify({
    experiment: 25, arm: 0, step: 'every transaction the chain holds, read back after a reproduction',
    run: label, intmax3: pin, chainId, head: Number(head),
    command: `npx tsx experiments/25-x18-intmax3-withdrawals-as-l1-5-jobs/chainlog.ts <rpc> ${label}`,
    transactions: txs,
  }, null, 2)}\n`)
  console.log(`${txs.length} transactions in ${Number(head) + 1} blocks; recorded ${out}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
