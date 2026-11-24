// The wallet's Q8 on experiment 22's local chain, EIP-8288 extended: exp-frames experiment 41's
// request, by its procedure "Running the request on a chain with EIP-8288 extended" (exp-frames
// exp/49-q8-fhe-input eb76c78), run here because the two sessions do not share a network.
//
// The chain is ethrex at the test network's commit with experiment 19's patch, extended, so that a
// leanSTARK dependency is valid and its proof is checked in the block. Its program directory is a
// fresh one in work/, holding experiment 19's programs and whatever program the request writes
// there, as docs/leanvm-program-layout.md section 5 asks. Its genesis funds the seed's leanSPHINCS
// funder. No secp256k1 key is set or used; the request goes to ethrex's own pool, since skandha's
// node path counts only leanSPHINCS proofs as checked.
//
// usage: npx tsx experiments/22-q1-leansphincs-senders/q8-local.ts <request binary> <pq_wallet binary> <label> <kohaku-rs commit>
// pq_wallet (experiment 49's) makes the seed and prints its funder's address; request does the rest.
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keccak256, type Hex } from 'viem'
import { run, startLocalChain } from '../../src/e2e/index.js'
import * as L from '../19-x14-hash-based-stealth-addresses-under-8288/lean.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const [requestBin, walletBin, label, walletCommit] = process.argv.slice(2)
if (!requestBin || !walletBin || !label || !/^[0-9a-f]{7,40}$/.test(walletCommit ?? '')) throw new Error('usage: q8-local.ts <request> <pq_wallet> <label> <kohaku-rs commit>')
// src/e2e loads the repository's .env on import, which sets PRIVATE_KEY. The procedure runs with it
// unset, so it is removed here and from every child's environment.
delete process.env.PRIVATE_KEY
const out = join(here, 'results', '41-local', label)
mkdirSync(out, { recursive: true })
const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
const secretDir = mkdtempSync(join(tmpdir(), 'q8-'))
chmodSync(secretDir, 0o700)
const seed = join(secretDir, 'seed')

const exec = (bin: string, env: Record<string, string>) => {
  const e = { ...process.env, ...env } as Record<string, string | undefined>
  delete e.PRIVATE_KEY
  try {
    return execFileSync(bin, [], { env: e as NodeJS.ProcessEnv, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 3_600_000 })
  } catch (err) {
    const x = err as { stdout?: string; stderr?: string; status?: number }
    return `exit ${x.status}\n${x.stdout ?? ''}\n${x.stderr ?? ''}`
  }
}

// ---- the seed and its funder, before the chain exists ----

// The funder's address depends on its carrier, since its code does: CARRIER=dependency here, as in
// the request itself (run 1 left it unset, and funded another address).
exec(walletBin, { MODE: 'new', SEED_FILE: seed, CARRIER: 'dependency' })
chmodSync(seed, 0o600)
const addresses = exec(walletBin, { MODE: 'addresses', SEED_FILE: seed, CARRIER: 'dependency' })
const funder = addresses.match(/funder\W+(0x[0-9a-fA-F]{40})/)?.[1]
if (!funder) throw new Error(`no funder address in MODE=addresses' output:\n${addresses.slice(0, 600)}`)

// ---- the program directory: experiment 19's programs, and room for the request's ----

const programs = join(root, 'work', `q8-programs-${label}`)
rmSync(programs, { recursive: true, force: true })
mkdirSync(programs, { recursive: true })
const x19 = join(root, 'experiments/19-x14-hash-based-stealth-addresses-under-8288/programs')
for (const f of readdirSync(x19)) copyFileSync(join(x19, f), join(programs, f))

const chain = await startLocalChain({
  root, label: `q8-${label}`, setting: 'extended', chainId: 8141, prover: L.PROVER, programs,
  alloc: { [funder]: { balance: '0x21e19e0c9bab2400000' } }, // 10,000 ETH
})
console.log(`local chain ${chain.chainId}, ethrex ${chain.ethrexCommit.slice(0, 8)} (${chain.setting}), pool VERIFY budget ${chain.maxVerifyGas}`)

let log = ''
const t0 = Date.now()
try {
  log = exec(requestBin, {
    RPC_URL: chain.url, CARRIER: 'dependency', WITNESS_DIR: chain.witnesses, PROGRAMS_DIR: programs,
    SEED_FILE: seed, RECORD: join(out, 'request.json'),
  })
  console.log(log.split('\n').slice(-30).join('\n'))
} finally {
  const seconds = Math.round((Date.now() - t0) / 1000)
  // Let the builder finish the block that holds the request before its records are read.
  await new Promise((r) => setTimeout(r, 15_000))
  const builds = chain.builds()
  const checks = chain.checks()
  await chain.stop()
  const programFiles = readdirSync(programs).filter((f) => !existsSync(join(x19, f))).map((f) => ({ file: f, key: keccak256(readFileSync(join(programs, f)) as unknown as Hex) }))
  const secretText = readFileSync(seed, 'utf8').trim()
  const words = secretText.split(/\s+/).filter((w) => w.length > 3)
  const summary = {
    experiment: 22, for: "exp-frames experiment 41's request (Q8), on the local chain with EIP-8288 extended", run: label, date: new Date().toISOString(), repoCommit,
    procedure: 'exp-frames exp/49-q8-fhe-input eb76c78, experiments/41-fhe-input-proof/README.md, "Running the request on a chain with EIP-8288 extended"',
    binaries: { request: `kohaku-rs ${walletCommit}, crates/fhe-input-pq, example request, RUSTFLAGS="-C target-cpu=native"`, seedAndFunder: 'kohaku-rs crates/frame-pq, example pq_wallet, MODE=new and MODE=addresses' },
    command: `npx tsx experiments/22-q1-leansphincs-senders/q8-local.ts <request> <pq_wallet> ${label} ${walletCommit}`,
    chain: { chainId: Number(chain.chainId), ethrex: chain.ethrexCommit, setting: chain.setting, maxVerifyGas: chain.maxVerifyGas, funder },
    programsAdded: programFiles, seconds, builds, checks, log,
  }
  const text = JSON.stringify(summary, null, 2)
  // The seed's words never reach a record: a check over every file this run wrote.
  const files = [join(out, 'run.json'), join(out, 'request.json')]
  if (existsSync(files[1])) { const t = readFileSync(files[1], 'utf8'); if (t.includes(secretText) || words.filter((w) => t.includes(` ${w} `)).length > 3) throw new Error('request.json holds seed words') }
  if (text.includes(secretText) || words.filter((w) => text.includes(` ${w} `)).length > 3) throw new Error('the summary would hold seed words')
  writeFileSync(files[0], text + '\n')
  rmSync(secretDir, { recursive: true, force: true })
  console.log(`recorded ${out}`)
}
process.exit(0)
