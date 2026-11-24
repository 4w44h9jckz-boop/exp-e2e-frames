// Experiment 29: exp-frames experiment 58's cases on the local chain, with simulated writes.
//
// Usage (from the repository root):
//   npx tsx experiments/29-the-exact-list-of-writes-on-the-local-chain/run.ts <n>-<label> <exp-frames checkout> <write-check> [--probe <case id>]
// The exp-frames checkout must be at a629da4 with its cases regenerated unchanged; write-check is
// kohaku-rs b9713ec's binary. --probe prints one case's raw write-check output and stops.
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { type Hex } from 'viem'
import { run, startLocalChain } from '../../src/e2e/index.js'
import * as L from '../19-x14-hash-based-stealth-addresses-under-8288/lean.js'

const exec = promisify(execFile)
const root = new URL('../../', import.meta.url).pathname
const here = new URL('.', import.meta.url).pathname
const [label, ef, wc] = process.argv.slice(2)
const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null)
const probe = arg('--probe')
const only = arg('--only')?.split('|') ?? null
const maxVerifyGas = arg('--max-verify-gas') ? Number(arg('--max-verify-gas')) : undefined
const expectEf = arg('--ef-commit') ?? 'a629da4'
if (!label || !/^\d+-[a-z0-9-]+$/.test(label) || !ef || !wc) throw new Error('usage: run.ts <n>-<label> <exp-frames checkout> <write-check> [--probe <id>]')
delete process.env.PRIVATE_KEY
const CASES = join(ef, 'experiments/58-write-list/cases')
const efCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: ef })).trim()
const efDirty = (await run('git', ['status', '--porcelain', '--', 'experiments/58-write-list'], { cwd: ef })).trim()
if (!efCommit.startsWith(expectEf) || efDirty) throw new Error(`exp-frames must be ${expectEf} with its cases unchanged (at ${efCommit.slice(0, 7)}, dirty: ${efDirty ? 'yes' : 'no'})`)
const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()

const cases: any[] = JSON.parse(readFileSync(join(CASES, 'cases.json'), 'utf8'))
const keys = JSON.parse(readFileSync(join(CASES, 'keys.json'), 'utf8'))
const alloc = JSON.parse(readFileSync(join(CASES, 'genesis-alloc.json'), 'utf8'))

const chain = await startLocalChain({ root, label: `e29-${label}`, setting: 'written', chainId: 8141, prover: L.PROVER, programs: join(root, 'experiments/19-x14-hash-based-stealth-addresses-under-8288/programs'), alloc, maxVerifyGas })
const url = chain.url
console.log(`local chain ${chain.chainId}, ethrex ${chain.ethrexCommit.slice(0, 9)}; exp-frames ${efCommit.slice(0, 7)}`)

const rpc = async (method: string, params: unknown[]) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const b = (await r.json()) as { result?: any; error?: { message: string } }
  if (b.error) throw new Error(`${method}: ${b.error.message}`)
  return b.result
}
async function writeCheck(raw: Hex, c: { template: string; params: Record<string, string>; rules: string }, sign: boolean) {
  const args = ['--raw', raw, '--layouts', join(CASES, 'layouts.json'), '--template', c.template, '--rules', c.rules, '--rpc', url]
  for (const [k, v] of Object.entries(c.params ?? {})) args.push('--param', `${k}=${v}`)
  if (sign) args.push('--sign')
  const env = { ...process.env, ...(sign ? { SIGNER_KEY: keys.owner.key } : {}) }
  try {
    const { stdout } = await exec(wc, args, { env, maxBuffer: 1 << 26 })
    return { out: JSON.parse(stdout), stderr: null }
  } catch (e: any) {
    return { out: e.stdout ? (() => { try { return JSON.parse(e.stdout) } catch { return { raw: e.stdout } } })() : null, stderr: String(e.stderr ?? e.message).slice(0, 600) }
  }
}
async function send(raw: Hex) {
  const hash = await rpc('eth_sendRawTransaction', [raw])
  for (let i = 0; i < 90; i++) {
    const rc = await rpc('eth_getTransactionReceipt', [hash])
    if (rc) return { hash, status: rc.status, block: Number(rc.blockNumber), gasUsed: Number(rc.gasUsed) }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return { hash, status: null }
}
const casesTs = async (...a: string[]) => (await exec('npx', ['tsx', 'experiments/58-write-list/cases.ts', ...a], { cwd: ef })).stdout.trim()

try {
  if (probe) {
    const c = cases.find((x) => x.id === probe)
    if (!c) throw new Error(`no case ${probe}`)
    const r = await writeCheck(c.raw, c, false)
    console.log(JSON.stringify(r, null, 1).slice(0, 6000))
  } else {
    const rows: any[] = []
    // 1 and 2: every runnable case judged against genesis; signed passes on ControlAccounts sent
    for (const c of cases.filter((x) => x.runnable && (!only || only.includes(x.id)))) {
      // judged without signing first: --sign refuses anything but a pass, and would lose the verdict
      const r = await writeCheck(c.raw, c, false)
      const verdict = r.out?.verdict?.status ?? 'error'
      const row: any = { id: c.id, family: c.family, template: c.template, rules: c.rules, predicted: c.predicted, verdict, matches: verdict === c.predicted, result: r.out, stderr: r.stderr }
      if (c.provisional && verdict === 'pass') {
        const s2 = await writeCheck(c.raw, c, true)
        const signed = s2.out?.signed?.raw ?? null
        row.signedQ = s2.out?.q ?? null
        row.sent = signed ? await send(signed as Hex) : { error: s2.stderr }
      }
      console.log(`${c.id}: predicted ${c.predicted}, got ${verdict}${row.sent ? `, sent: status ${row.sent.status}` : ''}`)
      rows.push(row)
    }
    // 3: the revert share
    const trials: any[] = []
    let seq = { h1: 0, h2: 0, noise: 0 }
    let state = 0x5829
    const rand = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff }
    for (const who of (only ? [] : ['h1', 'h2']) as ('h1' | 'h2')[]) {
      for (const p of [0, 0.25, 0.5, 1]) for (let t = 0; t < 8; t++) {
        const spec = JSON.parse(await casesTs('honest', who, String(seq[who])))
        const r = await writeCheck(spec.raw as Hex, { template: spec.template, params: spec.params, rules: 'f3079a0' }, true)
        const signed = r.out?.signed?.raw ?? null
        const noise = rand() < p
        let noiseSent = null
        if (noise) { noiseSent = await send(JSON.parse(await casesTs('noise', String(seq.noise))).raw as Hex); seq.noise++ }
        const honest = signed ? await send(signed as Hex) : null
        const v = r.out?.verdict?.status ?? `error: ${(r.stderr ?? '').slice(0, 160)}`
        trials.push({ who, p, trial: t, verdict: v, noise, noiseStatus: noiseSent?.status ?? null, honest })
        console.log(`${who} p=${p} #${t}: verdict ${v}, noise ${noise ? noiseSent?.status : '-'}, honest ${honest?.status ?? 'unsigned'}`)
        seq[who]++
      }
    }
    const out = join(here, 'results', `${label}.json`)
    mkdirSync(join(here, 'results'), { recursive: true })
    writeFileSync(out, `${JSON.stringify({ label, repoCommit, efCommit, writeCheck: wc, ethrex: chain.ethrexCommit, chainId: Number(chain.chainId), maxVerifyGas: maxVerifyGas ?? 100_000, only, cases: rows, revertShare: trials }, null, 1)}\n`)
    console.log(`wrote ${out}`)
  }
} finally {
  await chain.stop()
}
