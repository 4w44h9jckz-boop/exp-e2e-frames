// Experiment 24 (X17), arm R: Railgun's unshields on mainnet, from receipts (README, "Measures").
//
// Railgun's main contract on Ethereum is 0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9, the "ETH
// Deployment" docs.railgun.org lists under its helpful links. Its unshield emits
//   event Unshield(address to, TokenData token, uint256 amount, uint256 fee)
// with TokenData = (uint8 tokenType, address tokenAddress, uint256 tokenSubID), as
// contracts/logic/RailgunLogic.sol and Globals.sol in Railgun-Privacy/contract declare them at
// 36bcf5ed7cf94bfafb6e1a303e1832c769c16780. `fee` is the protocol's unshield fee, not a
// broadcaster's: a broadcaster is paid by a shielded note the chain does not show.
//
// For every transaction in the window that emits at least one Unshield, this reads the receipt:
// its sender, its gas and its price. It does not tell a broadcaster from a self-signing user, since
// both are plain accounts; it counts distinct senders and how many transactions each sent.
//
// usage: npx tsx experiments/24-x17-a-private-withdrawal-with-and-without-a-relayer/railgun.ts <n>-<label> [blocks]
//        MAINNET_RPC_URL overrides the RPC
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPublicClient, http, keccak256, toHex } from 'viem'
import { mainnet } from 'viem/chains'
import { run } from '../../src/e2e/index.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const label = process.argv[2]
if (!label || !/^\d+-[a-z0-9-]+$/.test(label)) throw new Error('usage: railgun.ts <n>-<label> [blocks]')
const WINDOW = BigInt(process.argv[3] ?? '7200')
const RPC = process.env.MAINNET_RPC_URL ?? 'https://mainnet.gateway.tenderly.co'
const RAILGUN = '0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9' as const
const CONTRACT_COMMIT = '36bcf5ed7cf94bfafb6e1a303e1832c769c16780'
const UNSHIELD = keccak256(toHex('Unshield(address,(uint8,address,uint256),uint256,uint256)'))
const client = createPublicClient({ chain: mainnet, transport: http(RPC, { retryCount: 6, retryDelay: 1_000, timeout: 30_000 }) })
const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()

const head = await client.getBlockNumber()
const from = head - WINDOW + 1n
const logs: { transactionHash: `0x${string}`; blockNumber: bigint | null }[] = []
const CHUNK = 1_000n
for (let b = from; b <= head; b += CHUNK) {
  const to = b + CHUNK - 1n > head ? head : b + CHUNK - 1n
  const part = await client.request({ method: 'eth_getLogs', params: [{ address: RAILGUN, topics: [UNSHIELD], fromBlock: toHex(b), toBlock: toHex(to) }] } as never) as { transactionHash: `0x${string}`; blockNumber: `0x${string}` }[]
  for (const l of part) logs.push({ transactionHash: l.transactionHash, blockNumber: BigInt(l.blockNumber) })
}
const hashes = [...new Set(logs.map((l) => l.transactionHash))]
const txs: { hash: string; block: number; from: string; gasUsed: number; priceWei: string; unshields: number }[] = []
for (const h of hashes) {
  const r = await client.getTransactionReceipt({ hash: h })
  txs.push({ hash: h, block: Number(r.blockNumber), from: r.from.toLowerCase(), gasUsed: Number(r.gasUsed), priceWei: r.effectiveGasPrice.toString(), unshields: r.logs.filter((l) => l.address.toLowerCase() === RAILGUN && l.topics[0] === UNSHIELD).length })
}
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null }
const bySender = new Map<string, number>()
for (const t of txs) bySender.set(t.from, (bySender.get(t.from) ?? 0) + 1)
const senders = [...bySender.entries()].sort((a, b) => b[1] - a[1])
const summary = {
  transactions: txs.length, unshieldEvents: logs.length, distinctSenders: senders.length,
  topSenderShare: txs.length ? Number((senders[0][1] / txs.length).toFixed(3)) : null,
  medianGasUsed: median(txs.map((t) => t.gasUsed)),
  gasUsedRange: txs.length ? [Math.min(...txs.map((t) => t.gasUsed)), Math.max(...txs.map((t) => t.gasUsed))] : null,
  topSenders: senders.slice(0, 5).map(([a, n]) => ({ sender: a, transactions: n })),
}
const record = {
  experiment: 24, arm: 'R', run: label, date: new Date().toISOString(), repoCommit,
  command: `npx tsx experiments/24-x17-a-private-withdrawal-with-and-without-a-relayer/railgun.ts ${label} ${WINDOW}`,
  rpc: RPC, contract: RAILGUN, contractSource: `Railgun-Privacy/contract ${CONTRACT_COMMIT}, contracts/logic/RailgunLogic.sol (event Unshield)`,
  blocks: { from: Number(from), to: Number(head) }, topic: UNSHIELD,
  exclusions: 'a broadcaster and a self-signing user are both plain senders here and are not told apart; the broadcaster\'s fee is a shielded note and is not on chain; Unshield\'s fee field is the protocol\'s 0.25%; failed transactions emit no Unshield and are missing',
  summary, transactions: txs,
}
writeFileSync(join(here, 'results', `${label}.json`), JSON.stringify(record, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
console.log(`recorded results/${label}.json`)
process.exit(0)
