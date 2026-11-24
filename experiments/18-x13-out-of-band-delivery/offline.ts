// Experiment 18 (X13), arms 7 to 10, offline, after a run.
//   7. The guards that must fail: a refund before T and a refund of a note made with T below the
//      recipient's floor have no witness; a ciphertext swapped by the store, or altered, finds no
//      leaf. (The spend with tNow past the registry's clock was refused on chain, in run.ts.)
//   8. FMD: 100,000 posts, 50 of them to our recipient, tested with detection keys of 4 and 8 keys.
//      Flags are made and tested in four processes, one per core; every flag is complete.
//   9. Linkage by timing at the store, in a simulation with a seed: 200 payments in one simulated
//      hour between 100 senders and 100 recipients, over delta in {0, 1, 10, 60} s and mu in {0, 1}.
//  10. The sender's view of the spend: the run's own spends, and 1,000 simulated notes with an
//      immediate spend and with the random spend time.
// Everything random comes from a seed, so the output is the same on every run.
//
// usage: X13_DEPLOYMENT=<tag> npx tsx experiments/18-x13-out-of-band-delivery/offline.ts <n>-<label>
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { type Hex, hexToBytes } from 'viem'
import * as F from './fmd.js'
import * as N from './notes.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname

/** A deterministic byte stream from a seed: SHA-256 of seed || counter. */
function stream(seed: string) {
  let i = 0
  const bytes = (n: number) => {
    const out = new Uint8Array(n)
    for (let o = 0; o < n; o += 32) out.set(createHash('sha256').update(`${seed}/${i++}`).digest().subarray(0, Math.min(32, n - o)), o)
    return out
  }
  const uniform = () => (Number(BigInt(`0x${Buffer.from(bytes(7)).toString('hex')}`) >> 3n) + 1) / 2 ** 53
  return { bytes, uniform }
}

// ---- arm 8's worker: one share of the flags ----

if (process.argv[2] === 'fmd-worker') {
  const [, , , w, from, to, trueEvery] = process.argv
  const me = F.keygen(stream('x13/fmd/recipient').bytes.bind(null, 32))
  const others = Array.from({ length: 50 }, (_, k) => F.keygen(stream(`x13/fmd/other/${k}`).bytes.bind(null, 32)))
  const r = stream(`x13/fmd/worker/${w}`)
  const d4 = F.extract(me.sk, 4)
  const d8 = F.extract(me.sk, 8)
  const counts = { true: 0, false: 0, n4: { truePositive: 0, falsePositive: 0 }, n8: { truePositive: 0, falsePositive: 0 }, flagMs: 0, testMs: 0 }
  for (let i = Number(from); i < Number(to); i++) {
    const ours = i % Number(trueEvery) === 0
    let t = performance.now()
    const f = F.flag(ours ? me.pk : others[i % 50].pk, () => r.bytes(32))
    counts.flagMs += performance.now() - t
    t = performance.now()
    const wPt = F.wOf(f)
    const hit4 = F.test(d4, f, wPt)
    const hit8 = hit4 && F.test(d8, f, wPt)
    counts.testMs += performance.now() - t
    if (ours) { counts.true++; if (hit4) counts.n4.truePositive++; if (hit8) counts.n8.truePositive++ } else { counts.false++; if (hit4) counts.n4.falsePositive++; if (hit8) counts.n8.falsePositive++ }
  }
  process.stdout.write(JSON.stringify(counts))
  process.exit(0)
}

const runLabel = process.argv[2]
if (!runLabel) throw new Error('usage: offline.ts <n>-<label>')
const record = JSON.parse(readFileSync(join(here, 'results', `${runLabel}.json`), 'utf8'))
const fixture = JSON.parse(readFileSync(join(root, 'test/fixtures/x13', `${runLabel}.json`), 'utf8'))
const out: Record<string, unknown> = { cpu: cpus()[0]?.model, cores: cpus().length, node: process.version }

// ---- arm 7: the guards that must fail ----

{
  const { prove, H } = await import('./x13.js')
  const { treeOf } = await import('../15-x10-out-and-back/x10.js')
  const s = stream('x13/guards')
  const f = () => BigInt(`0x${Buffer.from(s.bytes(31)).toString('hex')}`)
  const sk = f(), skS = f()
  const r = { pkR: H(sk), d: 60n }
  const T = 2_000_000n
  const t0 = T - 100n
  const tryProve = async (o: N.Opening, leafT0: bigint, tNow: bigint) => {
    const c = N.commitmentOf(o, r, 7n)
    const tree = treeOf([N.leafOf(c, leafT0)])
    const p = tree.path(0)
    try {
      await prove({ root: tree.root, nullifier: N.nullifierOf(o), tNow, outCommitment: H(o.value, 1n), value: o.value, pkR: r.pkR, d: r.d, n: o.n, s: o.s, h: 7n, T: o.T, refund: o.refund, t0: leafT0, branch: 1n, sk: skS, outInner: 1n, pathElements: p.pathElements, pathIndices: p.pathIndices })
      return 'proved'
    } catch (e) {
      return `no witness: ${(e as Error).message.split('\n')[0].replace(/^Error: /, '').slice(0, 80)}`
    }
  }
  const o = { value: N.DENOM, n: f(), s: f(), T, refund: H(skS) }
  const control = await tryProve(o, t0, T)
  const beforeT = await tryProve(o, t0, T - 1n)
  const belowFloor = await tryProve({ ...o, T: t0 + 59n }, t0, t0 + 59n)
  // A swapped ciphertext: one sealed to the recipient with another opening; an altered one.
  const kem = N.kemKeygen(s.bytes(64))
  const n1 = fixture.notes.find((n: { label: string }) => n.label === '1-invoice')
  const cs = new Set((fixture.notes as { c: Hex }[]).map((n) => BigInt(n.c)))
  const swapped = N.sealFirst(kem.ek, { ...o, n: f() }, s.bytes(32)).entry
  const opened = N.openFirst(kem.dk, swapped)!
  const swappedLeaf = cs.has(N.commitmentOf(opened.opening, r, N.hOf(swapped)))
  const altered = hexToBytes(n1.delivered as Hex).slice()
  altered[600] ^= 1
  out.arm7 = {
    refundAtT: control, refundBeforeT: beforeT, refundBelowFloor: belowFloor,
    swappedFindsLeaf: swappedLeaf, alteredOpens: N.openFirst(kem.dk, altered) !== undefined,
    futureTNowOnChain: record.rows.find((x: { step: string }) => x.step.startsWith('refused: tNow later'))?.simulation?.violation ?? null,
  }
  console.log(`arm 7: ${JSON.stringify(out.arm7)}`)
}

// ---- arm 8: FMD at 100,000 posts ----

{
  const TOTAL = 100_000
  const TRUE_EVERY = 2_000 // 50 of 100,000
  const workers = Math.min(4, cpus().length)
  const per = Math.ceil(TOTAL / workers)
  const t0 = Date.now()
  const parts = await Promise.all(Array.from({ length: workers }, (_, w) => new Promise<Record<string, unknown>>((ok, fail) => {
    const c = spawn(process.execPath, [...process.execArgv, new URL(import.meta.url).pathname, 'fmd-worker', String(w), String(w * per), String(Math.min(TOTAL, (w + 1) * per)), String(TRUE_EVERY)], { stdio: ['ignore', 'pipe', 'inherit'] })
    let s = ''
    c.stdout.on('data', (d) => { s += d })
    c.on('exit', (code) => (code === 0 ? ok(JSON.parse(s)) : fail(new Error(`worker ${w} exited ${code}`))))
  })))
  const sum = (k: string, j?: string) => parts.reduce((a, p) => a + (j ? (p[k] as Record<string, number>)[j] : (p[k] as number)), 0)
  const falseN = sum('false')
  const interval = (p: number) => { const sd = Math.sqrt((p * (1 - p)) / falseN); return [p - 3.2905 * sd, p + 3.2905 * sd] }
  const at = (n: 4 | 8) => {
    const fp = sum(`n${n}`, 'falsePositive')
    const p = 2 ** -n
    const [lo, hi] = interval(p)
    return { truePositive: sum(`n${n}`, 'truePositive'), of: sum('true'), falsePositive: fp, others: falseN, share: +(fp / falseN).toFixed(6), expected: p, interval999: [+lo.toFixed(6), +hi.toFixed(6)], inside: fp / falseN >= lo && fp / falseN <= hi, flaggedSet: fp + sum(`n${n}`, 'truePositive') }
  }
  out.arm8 = { posts: TOTAL, ours: sum('true'), workers, wallSeconds: Math.round((Date.now() - t0) / 1000), flagMsPerPost: +(sum('flagMs') / TOTAL).toFixed(3), testMsPerPost: +(sum('testMs') / TOTAL).toFixed(3), n4: at(4), n8: at(8) }
  console.log(`arm 8: ${JSON.stringify(out.arm8)}`)
}

// ---- arm 9: linkage by timing at the store ----

function simulate(delta: number, mu: number) {
  const s = stream(`x13/linkage/${delta}/${mu}`)
  const u = s.uniform
  const exp = (mean: number) => (mean <= 0 ? 0 : -mean * Math.log(u()))
  const HOUR = 3600
  // 200 payments, deposits uniform over the hour, each from a sender to a recipient.
  const pays = Array.from({ length: 200 }, (_, j) => ({ j, deposit: u() * HOUR, sender: Math.floor(u() * 100), recipient: Math.floor(u() * 100) }))
  pays.sort((a, b) => a.deposit - b.deposit)
  // Puts: within 2 s of the deposit, then the transport's delay.
  const puts = pays.map((p) => ({ j: p.j, at: p.deposit + 2 * u() + exp(delta) }))
  // Put to deposit: each put, in arrival order, to the latest unmatched deposit before it.
  const deposits = pays.map((p) => ({ j: p.j, at: p.deposit, used: false }))
  let right = 0
  for (const put of [...puts].sort((a, b) => a.at - b.at)) {
    const cand = deposits.filter((d) => !d.used && d.at <= put.at)
    const pick = cand[cand.length - 1]
    if (pick) { pick.used = true; if (pick.j === put.j) right++ }
  }
  // Sessions: a recipient comes online once, after its last payment, and fetches every note in
  // one session, 0.3 s apart; each fetch then takes the transport's delay. Cover traffic: random
  // gets from each of 200 clients at mu a minute.
  type Get = { at: number; who: number }
  const gets: Get[] = []
  for (let r = 0; r < 100; r++) {
    const mine = pays.filter((p) => p.recipient === r)
    if (!mine.length) continue
    const online = Math.max(...mine.map((p) => p.deposit)) + exp(600)
    mine.forEach((_, k) => gets.push({ at: online + 0.3 * k + exp(delta), who: r }))
  }
  if (mu > 0) for (let c = 0; c < 200; c++) for (let t = exp(60 / mu); t < HOUR; t += exp(60 / mu)) gets.push({ at: t, who: 1000 + c })
  gets.sort((a, b) => a.at - b.at)
  // Group consecutive fetches less than 5 s apart; precision over all pairs within a group.
  let pairs = 0
  let same = 0
  let group: Get[] = []
  const close = () => { for (let a = 0; a < group.length; a++) for (let b = a + 1; b < group.length; b++) { pairs++; if (group[a].who === group[b].who) same++ } group = [] }
  for (const g of gets) { if (group.length && g.at - group[group.length - 1].at >= 5) close(); group.push(g) }
  close()
  return { delta, mu, putToDeposit: +(right / puts.length).toFixed(4), sessionPrecision: pairs ? +(same / pairs).toFixed(4) : null, groupedPairs: pairs }
}
out.arm9 = [0, 1, 10, 60].flatMap((d) => [0, 1].map((m) => simulate(d, m)))
console.log(`arm 9: ${JSON.stringify(out.arm9)}`)

// ---- arm 10: the sender's view of the spend ----

{
  const spends = (record.rows as { step: string; branchTruth?: number; receivedAt?: number; wallAtBlock?: number; blockTime?: number }[])
    .filter((x) => x.step.startsWith('spend:') && x.branchTruth === 0 && x.receivedAt !== undefined)
    .map((x) => ({ step: x.step, errorSeconds: +((x.wallAtBlock as number) - (x.receivedAt as number)).toFixed(1) }))
  const s = stream('x13/sender-view')
  const W = 3600
  const sim = Array.from({ length: 1000 }, () => {
    const inclusion = 12 * s.uniform()
    return { immediate: inclusion, random: W * s.uniform() + inclusion }
  })
  const median = (xs: number[]) => { const a = [...xs].sort((p, q) => p - q); return a[Math.floor(a.length / 2)] }
  out.arm10 = {
    run: { window: 60, spends, medianErrorSeconds: median(spends.map((x) => x.errorSeconds)) },
    simulated: { notes: 1000, windowSeconds: W, immediateWithinOneBlock: sim.filter((x) => x.immediate <= 12).length / 1000, randomMedianError: +median(sim.map((x) => x.random)).toFixed(1), quarterWindow: W / 4 },
  }
  console.log(`arm 10: ${JSON.stringify(out.arm10)}`)
}

const file = join(here, 'results', `${runLabel}-offline.json`)
writeFileSync(file, JSON.stringify(out, null, 2) + '\n')
console.log(file)
process.exit(0)
