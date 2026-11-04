// Experiment 20: the chain a run uses, and how it records each step.
//   local    experiment 19's patched ethrex (ethrex.sh, ethrex-8288.patch) at the test network's
//            commit, in dev mode, EIP-8288 as written: every block's leanSPHINCS dependencies are
//            proved by leanVM's aggregation before the block is built on. The funder is ethrex's
//            first dev key, a published test key, not recorded.
//   testnet  the test network, EIP-8288 modelled: the triples travel in VERIFY's data, and the
//            reported gas is the measured gas plus 3,000 per declared triple. The funder is
//            PRIVATE_KEY's address.
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { keccak_256 } from '@noble/hashes/sha3'
import { type Hex, bytesToHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { loadKey, run } from '../../src/e2e/index.js'
import { sendFrames } from '../../src/exp-frames/deploy.js'
import { type Frame, type FrameTx, frameReceiptGas, frameReceiptStatus, frameTxHash, makeClient, serializeFrameTx, simulateFrameTx, waitForFrameTxReceipt } from '../../src/exp-frames/frametx/index.js'
import * as L from '../19-x14-hash-based-stealth-addresses-under-8288/lean.js'
import { LEANSPHINCS_VERIFICATION_GAS, type Placement } from './q6.js'

export const here = new URL('.', import.meta.url).pathname
export const root = new URL('../../', import.meta.url).pathname
const work = join(root, 'work')
const exp19 = join(root, 'experiments/19-x14-hash-based-stealth-addresses-under-8288')

export type Row = Record<string, unknown>
export async function openChain(where: 'local' | 'testnet', label: string) {
  const { privateKey } = loadKey()
  const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
  const secrets: string[] = [privateKey]
  let node: ChildProcess | undefined
  let stopping = false
  let url: string | undefined
  let funderKey: Hex = privateKey
  let witnesses = ''
  let ethrex: Record<string, unknown> | undefined
  if (where === 'local') {
    const ethrexDir = join(work, 'ethrex')
    const ethrexCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: ethrexDir })).trim()
    funderKey = readFileSync(join(ethrexDir, 'fixtures/keys/private_keys_l1.txt'), 'utf8').split('\n')[0].trim() as Hex
    secrets.push(funderKey)
    const dir = join(work, `q6-local-${label}`)
    rmSync(dir, { recursive: true, force: true })
    witnesses = join(dir, 'witnesses')
    mkdirSync(witnesses, { recursive: true })
    const genesis = JSON.parse(readFileSync(join(ethrexDir, 'fixtures/genesis/l1-hegota.json'), 'utf8'))
    genesis.baseFeePerGas = '0x7' // the test network's fee caps (100 wei) fit, as in experiment 19
    const genesisFile = join(dir, 'genesis.json')
    writeFileSync(genesisFile, JSON.stringify(genesis))
    const PORT = 18545
    node = spawn(join(ethrexDir, 'target/release/ethrex'), ['--dev', '--network', genesisFile, '--datadir', join(dir, 'db'), '--http.port', String(PORT), '--authrpc.port', '18551', '--authrpc.jwtsecret', join(dir, 'jwt.hex'), '--p2p.disabled', '--http.api', 'eth,net,web3,ethrex', '--log.level', 'info', '--mempool.max-verify-gas', '500000'], {
      env: { ...process.env, X14_EIP8288: 'written', X14_PROVER: L.PROVER, X14_PROGRAMS: join(exp19, 'programs'), X14_WITNESS_DIR: witnesses },
      stdio: ['ignore', openSync(join(dir, 'node.out'), 'w'), openSync(join(dir, 'node.log'), 'w')],
    })
    process.on('exit', () => node?.kill('SIGTERM'))
    node.on('exit', (code, signal) => { if (!stopping) console.log(`the node exited: ${code ?? signal}`) })
    url = `http://127.0.0.1:${PORT}`
    const { createHash } = await import('node:crypto')
    ethrex = { commit: ethrexCommit, patch: 'experiments/19-x14-hash-based-stealth-addresses-under-8288/ethrex-8288.patch', patchSha256: createHash('sha256').update(readFileSync(join(exp19, 'ethrex-8288.patch'))).digest('hex'), setting: 'written', genesis: 'fixtures/genesis/l1-hegota.json, base fee 7 wei', maxVerifyGas: 500_000, dir }
  }
  const chain = makeClient(url)
  for (let i = 0; ; i++) {
    try { await chain.getBlockNumber(); break } catch { if (i > 120) throw new Error('the node did not start'); await new Promise((r) => setTimeout(r, 1000)) }
  }
  const chainId = BigInt(await chain.getChainId())
  const placement: Placement = where === 'local' ? 'dep-frame' : 'modelled'
  const funder = privateKeyToAddress(funderKey)
  console.log(`${where}: chain ${chainId}, funder balance ${await chain.getBalance({ address: funder })}`)

  const rows: Row[] = []
  const setup: Row[] = []
  const txs: { step: string; hash: Hex; raw: Hex }[] = []
  const jsonl = (f: string) => witnesses && existsSync(join(witnesses, f)) ? readFileSync(join(witnesses, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []

  async function setupTx(what: string, frames: Frame[]) {
    const r = await sendFrames(chain, funderKey, frames, { label: what })
    if (!r?.hash || !r.receipt) throw new Error(`${what}: not mined`)
    const ok = r.receipt.frameReceipts.every((f) => frameReceiptStatus(f) === 1)
    const row = { what, hash: r.hash, block: Number(BigInt(r.receipt.blockNumber)), gasUsed: Number(BigInt(r.receipt.gasUsed)), ok }
    setup.push(row)
    if (!ok) throw new Error(`${what}: a frame failed`)
    return row
  }
  /** A leanSPHINCS dependency's witness, handed to the local node before its transaction. */
  function putWitness(triple: Hex, signed: L.Signed) {
    if (!witnesses) return
    const k = bytesToHex(keccak_256(Buffer.from(triple.slice(2 + 62), 'hex'))).slice(2)
    writeFileSync(join(witnesses, `w-${k}.json`), JSON.stringify({ publicKey: signed.publicKey, signature: signed.signature, message: signed.message }))
  }
  /** Simulate, then send; a refusal is recorded, and thrown unless `refusable`. */
  async function frameStep(step: string, tx: FrameTx, extra: Row = {}, refusable = false): Promise<Row> {
    const raw = serializeFrameTx(tx)
    const hash = frameTxHash(tx)
    const declared = Number(extra.declared ?? 0)
    const sim = await simulateFrameTx(chain, tx).catch((e) => ({ valid: false, violation: (e as Error).message.slice(0, 300), executionStatus: null }))
    let sent: string | undefined
    try { await chain.request({ method: 'eth_sendRawTransaction', params: [raw] } as never) } catch (e) { sent = String((e as { details?: string }).details ?? (e as Error).message).slice(0, 400) }
    if (sent) {
      const row = { step, outcome: 'refused by the node', refusal: sent, simulation: { valid: sim.valid, violation: sim.violation }, ...extra }
      console.log(`${step}: refused: ${sent.slice(0, 160)}`)
      rows.push(row)
      if (!refusable) throw new Error(`${step}: refused: ${sent}`)
      return row
    }
    const r = await waitForFrameTxReceipt(chain, hash, { timeoutMs: 300_000 })
    const frames = r.frameReceipts.map((f) => ({ status: frameReceiptStatus(f), ...frameReceiptGas(f) }))
    const ok = frames.every((f) => f.status === 1)
    const gasUsed = Number(BigInt(r.gasUsed))
    const row = {
      step, outcome: ok ? 'mined' : 'mined, a frame failed', hash, block: Number(BigInt(r.blockNumber)), gasUsed,
      reportedGas: placement === 'modelled' ? gasUsed + declared : gasUsed,
      frames: frames.map((f, i) => ({ mode: tx.frames[i].mode, status: f.status, execution: Number(f.execution), state: Number(f.state) })),
      calldataBytes: tx.frames.reduce((n, f) => n + (f.data.length - 2) / 2, 0), txBytes: (raw.length - 2) / 2,
      simulation: { valid: sim.valid, violation: sim.violation }, ...extra,
    }
    console.log(`${step}: ${hash} block ${row.block} gasUsed ${gasUsed} frames ${frames.map((f) => `${f.status}:${f.execution}+${f.state}s`).join(' / ')}`)
    rows.push(row)
    txs.push({ step, hash, raw })
    if (!ok && !refusable) throw new Error(`${step}: a frame failed`)
    return row
  }
  function stop() { stopping = true; node?.kill('SIGTERM') }
  /** Writes the record, refusing if any secret appears in it. */
  function write(file: string, record: Row) {
    const big = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)
    const body = JSON.stringify(record, big, 2)
    for (const s of secrets) {
      const bare = s.replace(/^0x/, '').toLowerCase()
      if (bare.length >= 32 && body.toLowerCase().includes(bare)) throw new Error(`${file} contains a secret; not written`)
    }
    mkdirSync(join(here, 'results'), { recursive: true })
    writeFileSync(join(here, 'results', file), `${body}\n`)
    console.log(`recorded results/${file}`)
  }
  return { where, label, privateKey, repoCommit, chain, chainId, placement, funder, funderKey, url, ethrex, witnesses, secrets, rows, setup, txs, jsonl, setupTx, putWitness, frameStep, stop, write, declaredGas: (k: number) => k * LEANSPHINCS_VERIFICATION_GAS }
}
export type Chain = Awaited<ReturnType<typeof openChain>>
