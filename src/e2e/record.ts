import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InclusionList } from './skandha.js'

/**
 * A run's record, kept as a fixture under `test/fixtures/runs/`: the pins, the commands, both nodes'
 * log lines for the transaction, the sender's standard output and the chain's facts. The tests
 * check it offline, so it survives a testnet relaunch.
 */
export type RunRecord = {
  experiment: string
  attempt: string
  ranAt: string
  pins: Record<string, { url: string; commit: string }>
  client: string
  commands: string[]
  nodes: { name: string; peerId: string; handoff: boolean; peers: string[]; lines: Record<string, unknown>[] }[]
  sender: { stdout: string[]; deposit?: string; depositBlock?: number }
  expect: 'mined' | 'refused'
  /** Inclusion lists a node answered while the transaction was pending, for runs that ask (experiment 02). */
  inclusionLists?: { node: string; focil: string; at: string; list: InclusionList }[]
  /** The run expects its transaction in a per-list (`eip-8369`) inclusion list from some node. */
  expectListed?: boolean
  chain: Record<string, unknown>
}

export const RUNS_DIR = new URL('../../test/fixtures/runs/', import.meta.url).pathname

export function writeRecord(hash: string, record: RunRecord): string {
  mkdirSync(RUNS_DIR, { recursive: true })
  const path = join(RUNS_DIR, `${hash}.json`)
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n')
  return path
}

export function readRecords(): { file: string; record: RunRecord }[] {
  return readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({ file, record: JSON.parse(readFileSync(join(RUNS_DIR, file), 'utf8')) as RunRecord }))
}
