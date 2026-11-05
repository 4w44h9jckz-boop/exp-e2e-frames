// The wallet's Q2, arms 2 to 6, on experiment 22's local chain (exp-frames experiment 49's
// procedure, "Running arms 2 to 6 on a chain with EIP-8288", at its commit 7421e07), run here
// because the two sessions do not share a network. Its binary is kohaku-rs's pq_wallet at f80adbe,
// built with target-cpu=native.
//
// The chain is ethrex at the test network's commit with experiment 19's EIP-8288 patch as written.
// Its genesis holds what the procedure asks for:
// - each seed's leanSPHINCS funder, with 1 ETH;
// - experiment 33's board, and experiment 06's keyed pool with its verifier and hasher, at their
//   test-network addresses, their code read from the test network at run time, with empty storage,
//   so the pool's tree starts empty;
// - the CREATE2 deployer, which ethrex's Hegota genesis already holds.
// No secp256k1 key is set or used. Each arm runs against ethrex directly, as the procedure says.
//
// usage: npx tsx experiments/22-q1-leansphincs-senders/q2-local.ts <pq_wallet binary> <label>
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Hex, keccak256 } from 'viem'
import { run, startLocalChain } from '../../src/e2e/index.js'
import { makeClient } from '../../src/exp-frames/frametx/index.js'
import * as L from '../19-x14-hash-based-stealth-addresses-under-8288/lean.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const [bin, label] = process.argv.slice(2)
if (!bin || !label) throw new Error('usage: q2-local.ts <pq_wallet> <label>')
// src/e2e loads the repository's .env on import, which sets PRIVATE_KEY. The procedure runs with it
// unset, so it is removed here and from every child's environment (wallet() below).
delete process.env.PRIVATE_KEY
const out = join(here, 'results', '49-local', label)
mkdirSync(out, { recursive: true })
const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
const secretDir = mkdtempSync(join(tmpdir(), 'q2-'))
chmodSync(secretDir, 0o700)
const seeds = { first: join(secretDir, 'seed-1'), second: join(secretDir, 'seed-2') }
const stateDir = join(secretDir, 'state')
mkdirSync(stateDir, { mode: 0o700 })

function wallet(mode: string, env: Record<string, string>, record?: string): string {
  const e = { ...process.env, MODE: mode, CARRIER: 'dependency', ...env, ...(record ? { RECORD: join(out, record) } : {}) }
  delete (e as Record<string, string | undefined>).PRIVATE_KEY
  try {
    return execFileSync(bin, [], { env: e, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 3_600_000 })
  } catch (err) {
    const x = err as { stdout?: string; stderr?: string; status?: number }
    return `exit ${x.status}\n${x.stdout ?? ''}\n${x.stderr ?? ''}`
  }
}

// ---- seeds and funders, before the chain exists ----

const funders: string[] = []
for (const s of [seeds.first, seeds.second]) {
  wallet('new', { SEED_FILE: s })
  chmodSync(s, 0o600)
  const a = wallet('addresses', { SEED_FILE: s })
  const f = a.match(/funder\W+(0x[0-9a-fA-F]{40})/)?.[1]
  if (!f) throw new Error(`no funder address in MODE=addresses' output:\n${a.slice(0, 600)}`)
  funders.push(f)
}

// ---- the genesis: the funders, and the contracts the procedure needs, from the test network ----

const testnet = makeClient()
const copied: Record<string, { code: Hex; codeHash: Hex }> = {}
for (const [name, address] of Object.entries({
  board: '0x93DD748B72dA1b1B6F1d5ec78Cb91ee52F01727d',
  keyedPool: '0x73e47a8DA2C83Beb802708Fc473B5B7D094f3eE6',
  poolVerifier: '0x87a7c1f76b03da00de489897d436bbeddd2133b7',
  poolHasher: '0x38955fbe81dbf136a84a1c711619c0ab8ce7813b',
} as const)) {
  const code = await testnet.getCode({ address })
  if (!code || code === '0x') throw new Error(`${name}: no code at ${address} on the test network`)
  copied[address.toLowerCase()] = { code, codeHash: keccak256(code) }
  console.log(`${name} ${address}: ${(code.length - 2) / 2} bytes`)
}
const alloc = Object.fromEntries([
  ...funders.map((f) => [f, { balance: '0xde0b6b3a7640000' }]), // 1 ETH each
  ...Object.entries(copied).map(([a, c]) => [a, { balance: '0x0', code: c.code }]),
])
const chain = await startLocalChain({
  root, label: `q2-${label}`, setting: 'written', chainId: 8141, prover: L.PROVER,
  programs: join(root, 'experiments/19-x14-hash-based-stealth-addresses-under-8288/programs'), alloc,
})
console.log(`local chain ${chain.chainId}, ethrex ${chain.ethrexCommit.slice(0, 8)} (${chain.setting})`)

// ---- the arms, in the procedure's order ----

const common = { RPC_URL: chain.url, WITNESS_DIR: chain.witnesses }
const logs: Record<string, string> = {}
const step = (name: string, mode: string, env: Record<string, string>, record?: string) => {
  const t0 = Date.now()
  const text = wallet(mode, { ...common, ...env }, record)
  logs[name] = text
  console.log(`== ${name} (${Math.round((Date.now() - t0) / 1000)} s)\n${text.split('\n').slice(-12).join('\n')}`)
}
try {
  step('arm 2', 'account', { SEED_FILE: seeds.first }, '2-account-local.json')
  step('arms 4 and 5', 'tickets', { SEED_FILE: seeds.first, RUN: '0' }, '3-tickets-local.json')
  step('arm 3', 'recover', { SEED_FILE: seeds.first, STATE_DIR: stateDir }, '4-recover-local.json')
  step('arm 6', 'seal', { SEED_FILE: seeds.first }, '5-seal-local.json')
  step('copy (a), second seed: account', 'account', { SEED_FILE: seeds.second }, '6-account-second-local.json')
  step('copy (a), second seed: tickets with SEND_COPY_A', 'tickets', { SEED_FILE: seeds.second, RUN: '0', SEND_COPY_A: '1' }, '7-tickets-copy-a-local.json')
} finally {
  const builds = chain.builds()
  const checks = chain.checks()
  await chain.stop()
  const secretsText = [readFileSync(seeds.first, 'utf8'), readFileSync(seeds.second, 'utf8')]
  const words = secretsText.flatMap((t) => t.trim().split(/\s+/)).filter((w) => w.length > 3)
  const summary = {
    experiment: 22, for: 'exp-frames experiment 49, arms 2 to 6 on the local chain', run: label, date: new Date().toISOString(), repoCommit,
    procedure: 'exp-frames exp/49-pq-keys 7421e07, experiments/49-pq-keys/README.md, "Running arms 2 to 6 on a chain with EIP-8288"',
    binary: 'kohaku-rs f80adbe, crates/frame-pq, example pq_wallet, RUSTFLAGS="-C target-cpu=native"',
    command: `npx tsx experiments/22-q1-leansphincs-senders/q2-local.ts <pq_wallet> ${label}`,
    chain: { chainId: Number(chain.chainId), ethrex: chain.ethrexCommit, setting: chain.setting, funders, copiedFromTestnet: Object.fromEntries(Object.entries(copied).map(([a, c]) => [a, c.codeHash])) },
    builds, checks, logs,
  }
  let text = JSON.stringify(summary, null, 2)
  // The seeds' words never reach a record: a check over every file this run wrote.
  const files = [join(out, 'run.json'), ...['2-account-local.json', '3-tickets-local.json', '4-recover-local.json', '5-seal-local.json', '6-account-second-local.json', '7-tickets-copy-a-local.json'].map((f) => join(out, f))]
  for (const f of files.slice(1)) if (existsSync(f)) { const t = readFileSync(f, 'utf8'); if (secretsText.some((s) => t.includes(s.trim())) || words.filter((w) => t.includes(` ${w} `)).length > 3) throw new Error(`${f} holds seed words`) }
  if (secretsText.some((s) => text.includes(s.trim()))) throw new Error('the summary would hold a seed')
  writeFileSync(files[0], text + '\n')
  rmSync(secretDir, { recursive: true, force: true })
  console.log(`recorded ${out}`)
}
process.exit(0)
