import { type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RPC_URL } from './env.js'
import { run, start, stop, until } from './sh.js'

/** Builds skandha as its FRAMES.md says, once per checkout. */
export async function buildSkandha(dir: string): Promise<void> {
  if (existsSync(join(dir, 'packages', 'cli', 'lib'))) return
  await run('bun', ['install'], { cwd: dir })
  await run('bun', ['run', 'build'], { cwd: dir })
}

/** The config FRAMES.md gives: it names the client; skandha's ERC-4337 settings in it are unused by frames. */
export function writeConfig(path: string, rpcUrl = RPC_URL): void {
  const ep = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108'
  const mempool = 'QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk'
  writeFileSync(
    path,
    JSON.stringify({
      entryPoints: [ep],
      relayers: ['0x' + '01'.repeat(32)],
      rpcEndpoint: rpcUrl,
      canonicalMempoolId: mempool,
      canonicalEntryPoint: ep,
      supportedMempools: [{ mempoolId: mempool, entryPoint: ep }],
    }),
  )
}

export type Node = {
  name: string
  apiPort: number
  peerId: string
  enr: string
  log: string
  out: string
  child: ChildProcess
}

/** Starts one skandha node with frames on, as FRAMES.md does, and waits for its RPC. */
export async function startNode(o: {
  dir: string
  name: string
  config: string
  dataDir: string
  apiPort: number
  wsPort: number
  p2pPort: number
  log: string
  out: string
  bootEnr?: string
  handoff?: boolean
}): Promise<Node> {
  const args = [
    'node', '--configFile', o.config, '--dataDir', o.dataDir,
    '--api.port', String(o.apiPort), '--api.wsPort', String(o.wsPort),
    '--p2p.port', String(o.p2pPort), '--p2p.host', '127.0.0.1',
    '--p2p.enrHost', '127.0.0.1', '--p2p.enrPort', String(o.p2pPort),
    ...(o.bootEnr ? ['--p2p.bootEnrs', o.bootEnr] : []),
    '--frames.enable', ...(o.handoff ? ['--frames.handoff'] : []),
    '--frames.name', o.name, '--frames.log', o.log,
  ]
  const child = start('./skandha', args, { cwd: o.dir, env: { NODE_BACKEND: 'js' } })
  let output = ''
  child.stdout?.on('data', (d) => (output += d))
  child.stderr?.on('data', (d) => (output += d))
  child.on('exit', () => writeFileSync(o.out, output))
  try {
    await until(`${o.name}'s RPC`, async () => (output.includes('HTTP server listening') ? true : undefined), 120_000)
  } catch (e) {
    await stop(child)
    throw e
  }
  writeFileSync(o.out, output)
  const enr = output.match(/ENR: (enr:[A-Za-z0-9_-]+)/)?.[1]
  // A node booted from another prints that peer's ID first, so read its own from the PeerId line.
  const peerId = output.match(/PeerId (16Uiu2[A-Za-z0-9]{40,})/)?.[1]
  if (!enr || !peerId) throw new Error(`${o.name}: no ENR or peer ID in its output`)
  return { name: o.name, apiPort: o.apiPort, peerId, enr, log: o.log, out: o.out, child }
}

/** The peer IDs a node is connected to, from `skandha_connectedPeers`. */
export async function peersOf(node: Node): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${node.apiPort}/rpc/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'skandha_connectedPeers', params: [] }),
  })
  const body = await res.json()
  return (body.result ?? []).map((p: { peerId: string }) => p.peerId)
}

export const rpcUrlOf = (node: Node) => `http://127.0.0.1:${node.apiPort}/rpc/`

/** What `skandha_frameInclusionList` answers: the list a node would publish from its pool at its head. */
export type InclusionList = {
  profile: string
  head: number
  baseFee: string
  transactions: string[]
  hashes: string[]
  verifyGas: string
  budget: string
  bytes: number
}

/**
 * The inclusion list a node would publish now, under a fill rule (`eip-8369` budgets each list on its
 * own; `ethrex` fills one budget over a slot's lists), as its FRAMES.md "As an includer" says.
 */
export async function inclusionListOf(node: Node, focil: 'eip-8369' | 'ethrex'): Promise<InclusionList> {
  const res = await fetch(rpcUrlOf(node), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'skandha_frameInclusionList', params: [{ focil }] }),
  })
  const body = await res.json()
  if (body.error) throw new Error(`skandha_frameInclusionList: ${JSON.stringify(body.error)}`)
  return body.result as InclusionList
}

/** Every line of a node's `--frames.log` that names `hash`. */
export function linesNaming(log: string, hash: string): Record<string, unknown>[] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l.toLowerCase().includes(hash.toLowerCase()))
    .map((l) => JSON.parse(l))
}

export { stop as stopNode }
