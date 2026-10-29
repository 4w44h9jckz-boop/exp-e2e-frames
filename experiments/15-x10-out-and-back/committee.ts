// Experiment 15's round committee: three members prove round4.circom with co-circom (REP3), as
// experiment 13 ran experiment 52's circuit. Each of the four owners secret-shares only its own
// fields (round4.circom names them m0_ .. m3_), deletes its plaintext file, and hands one share to
// each member. No member, and no file left behind, holds an owner's witness in the clear.
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '../../src/e2e/sh.js'
import { type Proof, proofWords, verifyWords } from './x10.js'

const here = new URL('.', import.meta.url).pathname
const quietEnv = { RUST_BACKTRACE: '0', RUST_LIB_BACKTRACE: '0', NO_COLOR: '1' }
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

export type Step = { what: string; millis: number; ok: boolean; tail?: string[] }
async function timed(what: string, cmd: string, args: string[], cwd: string): Promise<Step & { out: string }> {
  const t = Date.now()
  try {
    const out = await run(cmd, args, { cwd, env: quietEnv })
    return { what, millis: Date.now() - t, ok: true, out }
  } catch (e) {
    return { what, millis: Date.now() - t, ok: false, out: '', tail: plain((e as Error).message).split('\n').filter((l) => l.trim() && !/^\s+(at |\d+:)/.test(l)).slice(-4) }
  }
}

export function loopback() {
  const line = readFileSync('/proc/net/dev', 'utf8').split('\n').find((l) => l.trim().startsWith('lo:'))
  if (!line) throw new Error('no loopback interface in /proc/net/dev')
  const f = line.split(':')[1].trim().split(/\s+/).map(Number)
  return { rxBytes: f[0], rxPackets: f[1], txBytes: f[8], txPackets: f[9] }
}

const decimal = (v: unknown): unknown => (Array.isArray(v) ? v.map(decimal) : typeof v === 'bigint' ? v.toString() : v)
const decimalObject = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, decimal(v)]))

/**
 * Prove a round with three members on this machine. `pub` is the public part every owner's file
 * carries; `owners[k]` is owner k's own fields. Returns the proof as the verifier reads it, and
 * what each step cost.
 */
export async function committeeProve(o: {
  cocircom: string
  cosnarks: string
  nodeModules: string
  dir: string
  pub: Record<string, unknown>
  owners: Record<string, unknown>[]
  publics: bigint[]
}): Promise<{ proof: Proof; record: Record<string, unknown> }> {
  const ex = join(o.cosnarks, 'co-circom/co-circom/examples/data')
  const circuits = join(here, 'circuits')
  const circuit = join(circuits, 'round4.circom')
  const zkey = join(here, 'build/round4.zkey')
  const vkey = join(here, 'build/round4.vkey.json')
  for (const d of ['o0', 'o1', 'o2', 'o3', 'm']) mkdirSync(join(o.dir, d), { recursive: true })
  for (const i of [0, 1, 2]) {
    writeFileSync(join(o.dir, `party${i}.toml`), [
      '[compiler]', 'allow_leaky_loops = false', `link_library = ["${o.nodeModules}", "${circuits}"]`, '',
      '[vm]', 'allow_leaky_logs = false', '',
      '[network]', `my_id = ${i}`, `bind_addr = "0.0.0.0:${10400 + i}"`, '',
      ...[0, 1, 2].flatMap((j) => ['[[network.parties]]', `id = ${j}`, `dns_name = "127.0.0.1:${10400 + j}"`, '']),
      '[network.tls]', `key = "${join(ex, `key${i}.der`)}"`, `certs = [${[0, 1, 2].map((j) => `"${join(ex, `cert${j}.der`)}"`).join(', ')}]`, '',
    ].join('\n'))
  }
  const C = ['--circuit', circuit, '--protocol', 'REP3', '--curve', 'BN254']
  const before = loopback()
  const split: Step[] = []
  for (const [k, own] of o.owners.entries()) {
    const file = join(o.dir, `owner${k}.json`)
    writeFileSync(file, JSON.stringify(decimalObject({ ...o.pub, ...own })))
    const s = await timed(`owner ${k} splits its input`, o.cocircom, ['split-input', '--config', join(o.dir, 'party0.toml'), '--input', file, ...C, '--out-dir', join(o.dir, `o${k}`)], o.dir)
    rmSync(file)
    const { out: _, ...rest } = s
    split.push(rest)
    if (!s.ok) throw new Error(`owner ${k}: split-input failed: ${s.tail?.join(' / ')}`)
  }
  const merge = await Promise.all([0, 1, 2].map((i) => timed(`member ${i} merges the four owners' shares`, o.cocircom, ['merge-input-shares', '--config', join(o.dir, `party${i}.toml`), ...C,
    ...[0, 1, 2, 3].flatMap((k) => ['--inputs', join(o.dir, `o${k}`, `owner${k}.json.${i}.shared`)]), '--out', join(o.dir, 'm', `in.${i}.shared`)], o.dir)))
  if (!merge.every((m) => m.ok)) throw new Error(`merge failed: ${merge.map((m) => m.tail?.join(' / ')).join(' | ')}`)
  const t1 = Date.now()
  const witness = await Promise.all([0, 1, 2].map((i) => timed(`member ${i}, the witness`, 'timeout', ['600', o.cocircom, 'generate-witness', '-O1', '--config', join(o.dir, `party${i}.toml`),
    '--input', join(o.dir, 'm', `in.${i}.shared`), ...C, '--out', join(o.dir, 'm', `w.${i}.shared`)], o.dir)))
  const witnessMillis = Date.now() - t1
  if (!witness.every((w) => w.ok)) throw new Error(`witness failed: ${witness.map((w) => w.tail?.join(' / ')).join(' | ')}`)
  const t2 = Date.now()
  const proving = await Promise.all([0, 1, 2].map((i) => timed(`member ${i}, the proof`, 'timeout', ['600', o.cocircom, 'generate-proof', 'groth16', '--config', join(o.dir, `party${i}.toml`),
    '--witness', join(o.dir, 'm', `w.${i}.shared`), '--zkey', zkey, '--protocol', 'REP3', '--curve', 'BN254', '--out', join(o.dir, 'm', `proof.${i}.json`),
    ...(i === 0 ? ['--public-input', join(o.dir, 'public.json')] : [])], o.dir)))
  const provingMillis = Date.now() - t2
  if (!proving.every((p) => p.ok)) throw new Error(`proving failed: ${proving.map((p) => p.tail?.join(' / ')).join(' | ')}`)
  const after = loopback()
  const proofs = [0, 1, 2].map((i) => JSON.parse(readFileSync(join(o.dir, 'm', `proof.${i}.json`), 'utf8')))
  const membersAgree = proofs.every((p) => JSON.stringify(p) === JSON.stringify(proofs[0]))
  const publicSignals = (JSON.parse(readFileSync(join(o.dir, 'public.json'), 'utf8')) as string[]).map(BigInt)
  const signalsMatch = publicSignals.length === o.publics.length && publicSignals.every((x, i) => x === o.publics[i])
  const proof = proofWords(proofs[0])
  const verifies = await verifyWords('round4', proof, o.publics)
  const strip = (s: Step & { out: string }) => { const { out: _, ...rest } = s; return rest }
  const record = {
    members: 3,
    protocol: 'REP3 (co-circom), three processes on one machine over loopback TCP with TLS: a LAN time at best',
    split,
    merge: merge.map(strip),
    witness: witness.map(strip),
    witnessMillis,
    proving: proving.map(strip),
    provingMillis,
    loopback: { txBytes: after.txBytes - before.txBytes, txPackets: after.txPackets - before.txPackets, note: 'all three members, both directions, TLS included; nothing else was meant to run on the loopback' },
    membersAgree,
    signalsMatch,
    verifies,
  }
  if (!membersAgree || !signalsMatch || !verifies) throw new Error(`the committee's proof does not check: ${JSON.stringify({ membersAgree, signalsMatch, verifies })}`)
  return { proof, record }
}

export { readFileSync }
