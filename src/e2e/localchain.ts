// A local ethrex chain with EIP-8288 patched in, as experiment 19's local.ts starts one, for any
// experiment that needs a chain that checks dependencies: ethrex at the test network's commit with
// experiment 19's patch (work/ethrex, built by experiment 19's ethrex.sh), the Hegota genesis from
// ethrex's own fixtures, the base fee at its floor so the test network's fee caps apply, and extra
// allocations an experiment passes in, so an account can be funded without a transaction.
//
// The patch's block builder reads each dependency's witness from `witnesses`, named
// w-<keccak(scheme || data_hash || key)>.json for a leanSPHINCS signature, the data hash being the
// transaction's signature hash where the triple's is zero. It records every proof it builds in
// builds.jsonl and every check in checks.jsonl, in the same directory.
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Hex, keccak256 } from 'viem'
import { makeClient } from '../exp-frames/frametx/index.js'
import { run } from './sh.js'

export const LEANSTARK_SCHEME = 0x11
/** The patched builder's name for a dependency: keccak256 of the scheme's byte, the data hash and
 * the key, 65 bytes, as bare hex (the patch's `eip8288::dependency_key`). */
export function dependencyKey(scheme: number, dataHash: Hex, key: Hex): string {
  if (dataHash.length !== 66 || key.length !== 66) throw new Error('a data hash and a key are 32 bytes each')
  return keccak256(`0x${scheme.toString(16).padStart(2, '0')}${dataHash.slice(2)}${key.slice(2)}` as Hex).slice(2)
}

export type Alloc = Record<string, { balance: string; code?: Hex; nonce?: string; storage?: Record<string, Hex> }>
export type LocalChain = {
  url: string
  chainId: bigint
  dir: string
  witnesses: string
  ethrexCommit: string
  setting: 'written' | 'extended'
  /** The pool's VERIFY budget, as started. */
  maxVerifyGas: number
  client: ReturnType<typeof makeClient>
  /** A leanSPHINCS dependency's witness, written before its transaction is sent. */
  putSphincsWitness: (scheme: number, dataHash: Hex, key: Hex, signed: { publicKey: string; signature: string; message: string }) => string
  /** A leanSTARK dependency's proof bytes, written before its transaction is sent, as
   * `docs/leanvm-program-layout.md` section 5 has it. */
  putStarkWitness: (dataHash: Hex, programKey: Hex, proof: Uint8Array) => string
  /** The builder's records: every proof it built and every check it made. */
  builds: () => Record<string, unknown>[]
  checks: () => Record<string, unknown>[]
  stop: () => Promise<void>
}

export async function startLocalChain(o: {
  root: string
  label: string
  setting: 'written' | 'extended'
  prover: string
  programs: string
  alloc?: Alloc
  /** The genesis chain id. skandha's surface profiles fix theirs (`hegota-testnet` is 8141), so a
   * chain that two skandha nodes front takes 8141; ethrex's own Hegota fixture has 9. */
  chainId?: number
  port?: number
  authPort?: number
  /** `--mempool.max-verify-gas`, the pool's VERIFY budget: ethrex's default is EIP-8141's 100,000, the
   * test network's is 500,000. Mempool policy, not consensus. */
  maxVerifyGas?: number
}): Promise<LocalChain> {
  const work = join(o.root, 'work')
  const ethrexDir = join(work, 'ethrex')
  const ethrexCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: ethrexDir })).trim()
  const dir = join(work, `local-${o.label}`)
  rmSync(dir, { recursive: true, force: true })
  const witnesses = join(dir, 'witnesses')
  mkdirSync(witnesses, { recursive: true })
  const genesis = JSON.parse(readFileSync(join(ethrexDir, 'fixtures/genesis/l1-hegota.json'), 'utf8'))
  for (const [a, v] of Object.entries(o.alloc ?? {})) genesis.alloc[a.toLowerCase()] = v
  genesis.baseFeePerGas = '0x7'
  if (o.chainId !== undefined) genesis.config.chainId = o.chainId
  const genesisFile = join(dir, 'genesis.json')
  writeFileSync(genesisFile, JSON.stringify(genesis))
  const port = o.port ?? 18545
  const authPort = o.authPort ?? 18551
  const node: ChildProcess = spawn(join(ethrexDir, 'target/release/ethrex'), ['--dev', '--network', genesisFile, '--datadir', join(dir, 'db'), '--http.port', String(port), '--authrpc.port', String(authPort), '--authrpc.jwtsecret', join(dir, 'jwt.hex'), '--p2p.disabled', '--http.api', 'eth,net,web3,ethrex', '--log.level', 'info', ...(o.maxVerifyGas ? ['--mempool.max-verify-gas', String(o.maxVerifyGas)] : [])], {
    env: { ...process.env, X14_EIP8288: o.setting, X14_PROVER: o.prover, X14_PROGRAMS: o.programs, X14_WITNESS_DIR: witnesses },
    stdio: ['ignore', openSync(join(dir, 'node.out'), 'w'), openSync(join(dir, 'node.log'), 'w')],
  })
  let stopping = false
  node.on('exit', (code, signal) => { if (!stopping) console.log(`the local node exited: ${code ?? signal}`) })
  const url = `http://127.0.0.1:${port}`
  const client = makeClient(url)
  for (let i = 0; ; i++) {
    try { await client.getBlockNumber(); break } catch { if (i > 120) throw new Error('the local node did not start'); await new Promise((r) => setTimeout(r, 1000)) }
  }
  const chainId = BigInt(await client.getChainId())
  const jsonl = (f: string) => (existsSync(join(witnesses, f)) ? readFileSync(join(witnesses, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  return {
    url, chainId, dir, witnesses, ethrexCommit, setting: o.setting, maxVerifyGas: o.maxVerifyGas ?? 100_000, client,
    putSphincsWitness: (scheme, dataHash, key, signed) => {
      const k = dependencyKey(scheme, dataHash, key)
      writeFileSync(join(witnesses, `w-${k}.json`), JSON.stringify(signed))
      return k
    },
    putStarkWitness: (dataHash, programKey, proof) => {
      const k = dependencyKey(LEANSTARK_SCHEME, dataHash, programKey)
      writeFileSync(join(witnesses, `w-${k}.bin`), proof)
      return k
    },
    builds: () => jsonl('builds.jsonl'),
    checks: () => jsonl('checks.jsonl'),
    stop: async () => {
      stopping = true
      node.kill('SIGTERM')
      await new Promise((r) => setTimeout(r, 1500))
    },
  }
}
