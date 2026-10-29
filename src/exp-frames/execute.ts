import type { Hex, PublicClient } from 'viem'
import {
  type AnyKey,
  type FrameTx,
  type FrameTxReceiptJson,
  type SimulateResult,
  describeReceipt,
  describeSimulation,
  describeTx,
  sendFrameTx,
  signAll,
  simulateFrameTx,
  waitForFrameTxReceipt,
} from './frametx/index.js'

export const DRY_RUN = process.argv.includes('--dry-run')

export type Executed = { tx: FrameTx; sim: SimulateResult; hash?: Hex; receipt?: FrameTxReceiptJson }

/**
 * Sign with each key in turn, dry-run with ethrex_simulateFrameTransaction, and unless
 * `dryRun` (or the simulation says invalid), send and wait for the receipt.
 */
export async function execute(
  client: PublicClient,
  unsigned: FrameTx,
  keys: AnyKey[],
  { label, dryRun = DRY_RUN }: { label?: string; dryRun?: boolean } = {},
): Promise<Executed> {
  if (label) console.log(`\n=== ${label} ===`)
  let tx = unsigned
  tx = await signAll(tx, keys)
  console.log(describeTx(tx))
  const sim = await simulateFrameTx(client, tx)
  console.log(describeSimulation(sim))
  if (dryRun) return { tx, sim }
  if (!sim.valid) throw new Error(`not sending: simulation rejected the transaction (${sim.violation})`)
  const hash = await sendFrameTx(client, tx)
  console.log(`sent ${hash}`)
  const receipt = await waitForFrameTxReceipt(client, hash)
  console.log(describeReceipt(tx, receipt))
  return { tx, sim, hash, receipt }
}
