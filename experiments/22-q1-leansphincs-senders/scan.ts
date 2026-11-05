// Experiment 22 (Q1), arm 5: every block of the local chain, for any secp256k1 or P-256
// signature, in a signature list or as a transaction's own (README, prediction 7), with each
// block's leanSPHINCS dependencies. sweep.ts runs it before it stops the chain.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PublicClient } from 'viem'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export async function scanBlocks(client: PublicClient, witnesses: string) {
  const head = Number(await client.getBlockNumber())
  const builds = existsSync(join(witnesses, 'builds.jsonl')) ? readFileSync(join(witnesses, 'builds.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Json) : []
  const classical: Json[] = []
  const perBlock: Json[] = []
  let last: number | null = null
  for (let n = 0; n <= head; n++) {
    const block = (await client.request({ method: 'eth_getBlockByNumber', params: [`0x${n.toString(16)}`, true] } as never)) as Json
    const txs = (block.transactions ?? []) as Json[]
    let dependencies = 0
    for (const t of txs) {
      if (t.type !== '0x6') classical.push({ block: n, hash: t.hash, type: t.type, why: 'a transaction of its own type carries a secp256k1 signature' })
      for (const s of (t.signatures ?? []) as Json[]) if (s.scheme === '0x1' || s.scheme === '0x2') classical.push({ block: n, hash: t.hash, scheme: Number(s.scheme), why: 'a signature-list entry' })
      for (const f of (t.frames ?? []) as Json[]) if (f.mode === '0x4') dependencies += Math.floor((f.data.length - 2) / 192)
    }
    const ts = Number(block.timestamp)
    const built = builds.filter((b) => b.block === n)
    perBlock.push({ block: n, timestamp: ts, sinceParent: last === null ? null : ts - last, transactions: txs.length, dependencies, proof: built.length ? built[built.length - 1] : null })
    last = ts
  }
  return { blocks: head + 1, classical, perBlock }
}
