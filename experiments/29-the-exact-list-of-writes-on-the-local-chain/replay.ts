// Experiment 29, run 3 (deviation 2): the EIP-8250 replay on one chain's history, switched in place.
//
// Usage (from the repository root):
//   npx tsx experiments/29-the-exact-list-of-writes-on-the-local-chain/replay.ts <n>-<label> <exp-frames at 44101bb> <write-check> <second ethrex binary>
// The first half runs on work/ethrex's standard binary (EIP-8250 at f3079a0, both of this
// repository's patches); the node is stopped, and restarted on the same data directory with the
// second binary (the same tree plus exp-frames experiment 27's eip8250-master.patch).
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { type Hex } from 'viem'
import { run, startLocalChain } from '../../src/e2e/index.js'
import * as L from '../19-x14-hash-based-stealth-addresses-under-8288/lean.js'

const exec = promisify(execFile)
const root = new URL('../../', import.meta.url).pathname
const here = new URL('.', import.meta.url).pathname
const [label, ef, wc, second] = process.argv.slice(2)
if (!label || !/^\d+-[a-z0-9-]+$/.test(label) || !ef || !wc || !second) throw new Error('usage: replay.ts <n>-<label> <exp-frames> <write-check> <second ethrex binary>')
delete process.env.PRIVATE_KEY
const CASES = join(ef, 'experiments/58-write-list/cases')
const efCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: ef })).trim()
if (!efCommit.startsWith('44101bb')) throw new Error(`exp-frames must be at 44101bb (is ${efCommit.slice(0, 7)})`)
const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
const cases: any[] = JSON.parse(readFileSync(join(CASES, 'cases.json'), 'utf8'))
const original = cases.find((c) => c.id === 'A8250/original')
const replay = cases.find((c) => c.id === 'A8250/replay')
if (original.raw !== replay.raw) throw new Error('the two halves are not the same bytes')
const alloc = JSON.parse(readFileSync(join(CASES, 'genesis-alloc.json'), 'utf8'))
const programs = join(root, 'experiments/19-x14-hash-based-stealth-addresses-under-8288/programs')

const chainLabel = `e29-${label}`
const chain = await startLocalChain({ root, label: chainLabel, setting: 'written', chainId: 8141, prover: L.PROVER, programs, alloc })
let url = chain.url
const rpc = async (method: string, params: unknown[]) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const b = (await r.json()) as { result?: any; error?: { message: string } }
  if (b.error) throw new Error(`${method}: ${b.error.message}`)
  return b.result
}
async function writeCheck(rules: string) {
  const args = ['--raw', original.raw, '--layouts', join(CASES, 'layouts.json'), '--template', original.template, '--rules', rules, '--rpc', url]
  for (const [k, v] of Object.entries(original.params ?? {})) args.push('--param', `${k}=${v}`)
  try { return JSON.parse((await exec(wc, args, { maxBuffer: 1 << 26 })).stdout) } catch (e: any) { return { error: String(e.stderr ?? e.message).slice(0, 600) } }
}
async function send(raw: Hex) {
  let hash: string
  try { hash = await rpc('eth_sendRawTransaction', [raw]) } catch (e) { return { refused: (e as Error).message.slice(0, 400) } }
  for (let i = 0; i < 90; i++) {
    const rc = await rpc('eth_getTransactionReceipt', [hash])
    if (rc) return { hash, status: rc.status, block: Number(rc.blockNumber), gasUsed: Number(rc.gasUsed) }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return { hash, status: null }
}
const RECIPIENT = original.params.to
async function snapshot(sender: string, payer: string | null) {
  const n = async (a: string) => BigInt(await rpc('eth_getBalance', [a, 'latest'])).toString()
  return {
    block: Number(await rpc('eth_blockNumber', [])),
    senderNonce: Number(await rpc('eth_getTransactionCount', [sender, 'latest'])),
    recipient: await n(RECIPIENT),
    sender: await n(sender),
    payer: payer ? await n(payer) : null,
  }
}

const out: any = { label, repoCommit, efCommit, writeCheck: wc, secondBinary: second, firstBinary: join(root, 'work/ethrex/target/release/ethrex'), ethrex: chain.ethrexCommit }
let node: ChildProcess | null = null
try {
  // first half: EIP-8250 at f3079a0
  const v1 = await writeCheck('f3079a0')
  const sender = v1.sender
  const payer = v1.verdict?.exempt?.find((e: any) => e.kind === 'fee: the payer')?.change?.address ?? null
  out.first = { rules: 'f3079a0', verdict: v1, before: await snapshot(sender, payer) }
  out.first.sent = await send(original.raw)
  out.first.after = await snapshot(sender, payer)
  console.log(`first half (f3079a0): ${v1.verdict?.status ?? v1.error}; sent ${JSON.stringify(out.first.sent)}`)
  await chain.stop()

  // the switch: the same data directory, the second binary
  const dir = join(root, 'work', `local-${chainLabel}`)
  node = spawn(second, ['--dev', '--network', join(dir, 'genesis.json'), '--datadir', join(dir, 'db'), '--http.port', '18545', '--authrpc.port', '18551', '--authrpc.jwtsecret', join(dir, 'jwt.hex'), '--p2p.disabled', '--http.api', 'eth,net,web3,ethrex', '--log.level', 'info'], {
    env: { ...process.env, X14_EIP8288: 'written', X14_PROVER: L.PROVER, X14_PROGRAMS: programs, X14_WITNESS_DIR: join(dir, 'witnesses') },
    stdio: ['ignore', openSync(join(dir, 'node2.out'), 'w'), openSync(join(dir, 'node2.log'), 'w')],
  })
  url = 'http://127.0.0.1:18545'
  for (let i = 0; ; i++) { try { await rpc('eth_blockNumber', []); break } catch { if (i > 120) throw new Error('the second node did not start'); await new Promise((r) => setTimeout(r, 1000)) } }
  await new Promise((r) => setTimeout(r, 3000))

  // second half: EIP-8250 at master, the identical bytes
  const v2 = await writeCheck('master')
  out.second = { rules: 'master', verdict: v2, before: await snapshot(sender, payer) }
  out.second.sent = await send(replay.raw)
  out.second.after = await snapshot(sender, payer)
  console.log(`second half (master): ${v2.verdict?.status ?? v2.error}; sent ${JSON.stringify(out.second.sent)}`)
} finally {
  if (node) { node.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 1500)) }
  mkdirSync(join(here, 'results'), { recursive: true })
  const file = join(here, 'results', `${label}.json`)
  writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`)
  console.log(`wrote ${file}`)
}
