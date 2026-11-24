// Experiment 25 (X18), arm 0 on the local chain: what INTMAX3's test starts when it starts `anvil`.
//
// INTMAX3's partial-withdrawal test spawns `anvil --hardfork prague --port <p> ...` from PATH and
// talks to it over JSON-RPC. `local.sh` puts `anvil/anvil` first on PATH for that one run, which
// runs this file with the same arguments. It starts experiment 22's local chain (ethrex at the test
// network's commit with experiment 19's EIP-8288 patch, as written) at chain id 31337, and serves
// it on the port the test asked for. Nothing in INTMAX3 changes.
//
// What differs from anvil, all recorded, none hidden from the test:
// - The chain is ethrex's, under its own Hegota rules: its gas schedule, EIP-7825's cap of 25,000,000
//   gas per transaction, and a code size limit of 65,536 bytes from Amsterdam on. The test's
//   `--hardfork prague`, `--code-size-limit` and `--gas-limit` are read and recorded, not applied.
// - Blocks come from ethrex's dev producer, one a second, each marked finalized at once. anvil mines
//   only on a transaction and serves `finalized` 64 blocks behind.
// - The one anvil-only method the test's flow calls, `anvil_mine` (INTMAX3's `channel_member`, with
//   `INTMAX_WALLET_ANVIL_MINE=1`), is answered by waiting until the chain's own producer has made
//   that many more blocks. Real blocks are mined; none is synthesized. Any other `anvil_`, `evm_` or
//   `hardhat_` method is refused with an error, and the refusal is logged.
//
// anvil's ten development accounts are funded at genesis by address, as anvil funds them. Their
// keys are the public development keys INTMAX3's test carries; this file holds no key.
//
// The launcher logs every request's method and every refusal to work/intmax3-local-<label>/rpc.log.
// It keeps running after the test kills it, so that chainlog.ts can read the chain back; local.sh
// stops it.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { startLocalChain } from '../../src/e2e/localchain.js'
import * as L from '../19-x14-hash-based-stealth-addresses-under-8288/lean.js'

const here = new URL('.', import.meta.url).pathname
const root = join(here, '../..')
const label = process.env.X18_LOCAL_LABEL ?? 'local'
const dir = join(root, 'work', `intmax3-local-${label}`)
mkdirSync(dir, { recursive: true })
const log = (line: string) => appendFileSync(join(dir, 'rpc.log'), `${new Date().toISOString()} ${line}\n`)

// anvil's default development accounts (mnemonic "test test ... junk"), by address only.
const ANVIL_ACCOUNTS = [
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  '0x976EA74026E726554dB657fA54763abd0C3a0aa9', '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955',
  '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f', '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720',
]

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

async function main() {
  const args = process.argv.slice(2)
  const port = Number(arg(args, '--port') ?? '8545')
  const alloc = Object.fromEntries(ANVIL_ACCOUNTS.map((a) => [a, { balance: '0x21e19e0c9bab2400000' }]))
  const chain = await startLocalChain({
    root, label: `intmax3-${label}`, setting: 'written', chainId: 31337, port: port + 10_000,
    authPort: port + 10_001, prover: L.PROVER,
    programs: join(root, 'experiments/19-x14-hash-based-stealth-addresses-under-8288/programs'), alloc,
  })
  const upstream = chain.url
  writeFileSync(join(dir, 'launch.json'), `${JSON.stringify({
    asked: args, servedPort: port, upstream, chainId: Number(chain.chainId), ethrex: chain.ethrexCommit,
    setting: chain.setting, notApplied: { hardfork: arg(args, '--hardfork') ?? null,
      codeSizeLimit: arg(args, '--code-size-limit') ?? null, gasLimit: arg(args, '--gas-limit') ?? null },
  }, null, 2)}\n`)

  const forward = async (body: string) => {
    const r = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    return r.text()
  }
  const head = async () => BigInt(JSON.parse(await forward(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }))).result)

  // One request, or a batch, answered in order.
  const answer = async (req: { id: unknown; method: string; params?: unknown[] }) => {
    log(req.method)
    if (req.method === 'anvil_mine') {
      const n = BigInt((req.params?.[0] as string | undefined) ?? '0x1')
      const start = await head()
      while ((await head()) < start + n) await new Promise((r) => setTimeout(r, 250))
      log(`anvil_mine ${n}: waited from block ${start} to ${await head()}`)
      return { jsonrpc: '2.0', id: req.id, result: null }
    }
    if (/^(anvil|evm|hardhat)_/.test(req.method)) {
      log(`refused ${req.method}`)
      return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `${req.method} is anvil's; this chain is ethrex` } }
    }
    return JSON.parse(await forward(JSON.stringify(req)))
  }

  createServer((rq, rs) => {
    let body = ''
    rq.on('data', (c) => { body += c })
    rq.on('end', async () => {
      try {
        const parsed = JSON.parse(body)
        const out = Array.isArray(parsed) ? await Promise.all(parsed.map(answer)) : await answer(parsed)
        rs.writeHead(200, { 'content-type': 'application/json' })
        rs.end(JSON.stringify(out))
      } catch (e) {
        log(`error ${(e as Error).message}`)
        rs.writeHead(500)
        rs.end()
      }
    })
  }).listen(port, '127.0.0.1', () => log(`serving ${upstream} on ${port}`))
}

main().catch((e) => { log(`launcher failed: ${(e as Error).message}`); process.exit(1) })
