// Experiment 32, run: every case of the README against the reference keystore, each statement proved
// by experiment 19's prover, and one record.
//
// usage: npx tsx experiments/32-a-shared-keystore-for-stealth-accounts-in-leanvm/run.ts <label>
//
// Writes results/<label>.json. Every seed comes from a public label (fromLabel), so the record holds
// no secret worth keeping; proofs kept for case (g) go to results/proofs/, which is not committed.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Keystore, Refused, accountOf, kappaOf, H, cellsOf, type Entry } from './keystore.js'
import {
  HASHES_OUTSIDE_VERIFIER, MODE, type Identity, type Input, type Proved, type Rule, assemble, digestOf, fromLabel, prove, registerInput, rotateInput,
  signaturesOf, spendInput, tables, verifyAgainst,
} from './x32.js'

const label = process.argv[2]
if (!label) throw new Error('usage: run.ts <label>')
const here = new URL('.', import.meta.url).pathname
const out = join(here, 'results', `${label}.json`)
const proofs = join(here, 'results', 'proofs')
mkdirSync(proofs, { recursive: true })

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}`
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim()
const t = tables()
const programs = { spend: assemble('spend'), register: assemble('register'), rotate: assemble('rotate') }
const record: Record<string, unknown> = {
  experiment: 32,
  label,
  commit,
  date: new Date().toISOString(),
  machine: { cores: Number(execFileSync('nproc', { encoding: 'utf8' }).trim()), memKiB: Number(/MemTotal:\s+(\d+)/.exec(execFileSync('cat', ['/proc/meminfo'], { encoding: 'utf8' }))![1]) },
  leanVM: '3cbac047160f4d1465bfe985521603b0a3418556',
  tableChecks: t.checks,
  programs: Object.fromEntries(Object.entries(programs).map(([k, v]) => [k, { key: v.key, bytes: v.bytes }])),
  hashesOutsideVerifier: HASHES_OUTSIDE_VERIFIER,
}
const cases: Record<string, unknown> = {}
record.cases = cases
const save = () => writeFileSync(out, `${JSON.stringify(record, null, 1)}\n`)

type Outcome = { proved: boolean; error?: string; m?: Omit<Proved, 'details'> & { details: string } }
function attempt(path: string, input: Input, repeat = 0, keep?: string): Outcome {
  const r = prove(path, keep ? { ...input, proofOut: join(proofs, `${keep}.bin`) } : input, repeat)
  if ('error' in r) return { proved: false, error: r.error.slice(0, 300) }
  return { proved: r.verified, m: r }
}
function step(name: string, o: unknown) {
  cases[name] = o
  const p = o as { proved?: boolean; refused?: string; accepted?: boolean }
  console.log(`${name}: ${JSON.stringify(p.proved ?? p.accepted ?? p.refused ?? o).slice(0, 160)}`)
  save()
}
const keystoreTry = (f: () => unknown): { accepted: boolean; refused?: string } => {
  try { f(); return { accepted: true } } catch (e) { if (e instanceof Refused) return { accepted: false, refused: e.message }; throw e }
}

const seed = (s: string) => fromLabel(s)
const one = (k: string): Rule => ({ rule: 1n, seeds: [seed(k)] })
const twoOfThree = (a: string, b: string, c: string): Rule => ({ rule: 2n, seeds: [seed(a), seed(b), seed(c)] })
const padded = (k: string): Rule => ({ rule: 2n, seeds: [seed(k), seed(k), undefined] })
const ident = (name: string, rule: Rule, recovery: Rule): Identity => ({ s: seed(`${name}/s`), version: 0, rule, rec: digestOf(recovery), salt: seed(`${name}/salt/0`), recovery })

const ks = new Keystore()
const A = ident('A', one('A/k0'), one('A/rec0'))
const B = ident('B', twoOfThree('B/k0', 'B/k1', 'B/k2'), one('B/rec0'))
const P = ident('P', padded('P/k0'), one('P/rec0'))
const H1 = ident('H1', one('H1/k0'), one('H1/rec0'))
const H2 = ident('H2', one('H2/k0'), one('H2/rec0'))
const fillers = Array.from({ length: 5 }, (_, i) => ident(`F${i}`, one(`F${i}/k0`), one(`F${i}/rec0`)))

// ---- registrations: each identity's leaf at version 0, A and B measured ----
for (const [name, id] of [['A', A], ['B', B], ['P', P], ['H1', H1], ['H2', H2], ...fillers.map((f, i) => [`F${i}`, f] as const)] as const) {
  const reg = registerInput(id)
  const measured = name === 'A' || name === 'B'
  const o = attempt(programs.register.path, reg.input, measured ? 3 : 0)
  const k = keystoreTry(() => ks.register(reg.leaf, reg.q))
  step(`register/${name}`, { ...o, keystore: k, leaf: hex(reg.leaf), q: hex(reg.q) })
}

// ---- (a) an honest spend at version 0, under each rule, measured ----
const r = seed('A/r/0')
const m = seed('m/0')
const sa = spendInput(ks, A, r, m)
step('a/one-key', { ...attempt(programs.spend.path, sa.input, 3, 'a-one-key'), C: hex(sa.C), D: hex(sa.D), rho: hex(sa.rho) })
const sb = spendInput(ks, B, seed('B/r/0'), m)
step('a/two-of-three', { ...attempt(programs.spend.path, sb.input, 3), D: hex(sb.D) })
const sp = spendInput(ks, P, seed('P/r/0'), m)
step('a/padded-one-key', { ...attempt(programs.spend.path, sp.input, 3), D: hex(sp.D) })

// ---- (b) a rotation under the current rule, then a spend at the next version ----
const before = ks.snapshot()
const nextA = { rule: one('A/k0/v1'), rec: A.rec, salt: seed('A/salt/1') }
const ra = rotateInput(ks, A, nextA, MODE.rotate)
step('b/rotate', { ...attempt(programs.rotate.path, ra.input, 3), D: hex(ra.D), n: hex(ra.n), nextLeaf: hex(ra.nextLeaf) })
step('b/keystore', keystoreTry(() => ks.rotate(ra.n, ra.nextLeaf)))
const A1: Identity = { ...A, version: 1, rule: nextA.rule, salt: nextA.salt }
const s1 = spendInput(ks, A1, r, seed('m/1'))
step('b/spend-next-version', { ...attempt(programs.spend.path, s1.input), rho: hex(s1.rho) })
const rb = rotateInput(ks, B, { rule: twoOfThree('B/k0/v1', 'B/k1/v1', 'B/k2/v1'), rec: B.rec, salt: seed('B/salt/1') }, MODE.rotate)
step('b/rotate-two-of-three', { ...attempt(programs.rotate.path, rb.input, 3) })

// ---- (c) a spend under the revoked version against the root after the rotation ----
const kappa = kappaOf(ra.n)
const own = ks.entries.find((e) => e.a === kappa)!
const below = ks.entries.find((e) => e.b === kappa)!
const oldBracket = before.bracket(kappa)!
const tryRevoked = (name: string, ov: Entry & { tree?: Keystore }) => {
  const s = spendInput(ks, A, r, seed('m/2'), { absenceOverride: ov })
  step(name, { ...attempt(programs.spend.path, s.input), entry: [ov.a.toString(16), ov.b.toString(16)] })
}
step('c/revoked-check', { revokedInKeystore: ks.isRevoked(ra.n), kappa: kappa.toString(16) })
tryRevoked('c1/own-entry', own)
tryRevoked('c2/entry-below', below)
tryRevoked('c3/old-bracket-old-path', { ...oldBracket, tree: before })

// ---- (d) the same spend against the root before the rotation ----
const sd = spendInput(before, A, r, seed('m/2'))
step('d/old-root', { ...attempt(programs.spend.path, sd.input), rho: hex(sd.rho), rhoNow: hex(ks.root()) })

// ---- (e) s and r known, with a key that is not the leaf's ----
const attacker = one('attacker/k0')
const e1 = spendInput(ks, A1, r, seed('m/3'), { leafKeys: attacker, sigs: signaturesOf(attacker, seed('m/3')) })
step('e1/attacker-keys-in-leaf', { ...attempt(programs.spend.path, e1.input), leafInTree: e1.leafIndex >= 0 })
const e2 = spendInput(ks, A1, r, seed('m/3'), { sigs: signaturesOf(A1.rule, seed('m/3'), [seed('attacker/k0')]) })
step('e2/attacker-signature', { ...attempt(programs.spend.path, e2.input) })

// ---- (f) a leaf for a known identity without a signed rotation ----
const again = registerInput({ ...A1, version: 0, rule: attacker, salt: seed('A/salt/again') })
step('f1/second-registration', { ...attempt(programs.register.path, again.input), keystore: keystoreTry(() => ks.register(again.leaf, again.q)) })
// The attacker signs the rotation message itself, so only the key, not the message, is wrong.
const f2 = rotateInput(ks, A1, { rule: attacker, rec: A.rec, salt: seed('A/salt/f2') }, MODE.rotate, { sigs: [] })
const f2b = rotateInput(ks, A1, { rule: attacker, rec: A.rec, salt: seed('A/salt/f2') }, MODE.rotate, { sigs: signaturesOf(attacker, f2.mrot) })
step('f2/rotation-by-another-key', { ...attempt(programs.rotate.path, f2b.input) })
const f3 = registerInput(fillers[0], { regSecret: seed('other/s') })
step('f3/registration-tag-of-another-secret', { ...attempt(programs.register.path, f3.input) })

// ---- (g) the proof of (a) against other public values ----
const kept = join(proofs, 'a-one-key.bin')
const Cother = accountOf(A.s, seed('A/r/other'))
const Dc = H(H(Cother, m), sa.rho)
const Dm = H(H(sa.C, seed('m/other')), sa.rho)
step('g/control', verifyAgainst(programs.spend.path, cellsOf(sa.D), kept))
step('g/other-account', verifyAgainst(programs.spend.path, cellsOf(Dc), kept))
step('g/other-message', verifyAgainst(programs.spend.path, cellsOf(Dm), kept))

// ---- (h) the recovery rule ----
// Run 1: queued, cancelled by the current key within the delay, then an execution is refused.
const nextH1 = { rule: one('H1/k0/v1'), rec: H1.rec, salt: seed('H1/salt/1') }
const rec1 = rotateInput(ks, H1, nextH1, MODE.recover)
step('h1/recover', { ...attempt(programs.rotate.path, rec1.input, 3), keystore: keystoreTry(() => ks.recover(rec1.n, rec1.nextLeaf)), clock: ks.clock })
ks.tick(5)
const can1 = rotateInput(ks, H1, nextH1, MODE.cancel)
step('h1/cancel', { ...attempt(programs.rotate.path, can1.input), keystore: keystoreTry(() => ks.cancel(can1.n, can1.nextLeaf)), clock: ks.clock })
ks.tick(10)
step('h1/execute-after-cancel', { ...keystoreTry(() => ks.execute(rec1.n, rec1.nextLeaf)), clock: ks.clock })
// Run 2: queued, refused one tick early, executed after the delay; then the new version spends
// and the old does not.
const nextH2 = { rule: one('H2/k0/v1'), rec: H2.rec, salt: seed('H2/salt/1') }
const rec2 = rotateInput(ks, H2, nextH2, MODE.recover)
step('h2/recover', { ...attempt(programs.rotate.path, rec2.input), keystore: keystoreTry(() => ks.recover(rec2.n, rec2.nextLeaf)), clock: ks.clock })
ks.tick(9)
step('h2/execute-one-tick-early', { ...keystoreTry(() => ks.execute(rec2.n, rec2.nextLeaf)), clock: ks.clock })
ks.tick(1)
step('h2/execute', { ...keystoreTry(() => ks.execute(rec2.n, rec2.nextLeaf)), clock: ks.clock })
const H2v1: Identity = { ...H2, version: 1, rule: nextH2.rule, salt: nextH2.salt }
step('h2/spend-new-version', { ...attempt(programs.spend.path, spendInput(ks, H2v1, seed('H2/r/0'), seed('m/h2')).input) })
step('h2/spend-old-version', { ...attempt(programs.spend.path, spendInput(ks, H2, seed('H2/r/0'), seed('m/h2b')).input) })

// ---- (i) one key, two of three, and padded one key: five spends each ----
const rows = (details: string) => Object.fromEntries([...details.matchAll(/([A-Z_]+) 2\^([\d.]+)/g)].map((x) => [x[1], Number(x[2])]))
for (const [name, id] of [['one-key', A1], ['two-of-three', B], ['padded-one-key', P]] as const) {
  const runs = []
  for (let i = 0; i < 5; i++) {
    const s = spendInput(ks, id, seed(`${name}/r/${i}`), seed(`i/${name}/${i}`))
    const o = attempt(programs.spend.path, s.input)
    runs.push({ proved: o.proved, error: o.error, proofBytes: o.m?.proofBytes, verifyMs: o.m?.verifyMs, cycles: o.m?.cycles, rows: o.m ? rows(o.m.details) : undefined, publicCells: 2 })
  }
  step(`i/${name}`, { proved: runs.every((x) => x.proved), runs, program: programs.spend.key })
}

record.finished = new Date().toISOString()
save()
console.log(`wrote ${out}`)
