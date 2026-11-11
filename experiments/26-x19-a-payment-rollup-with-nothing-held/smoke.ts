// Experiment 26 (X19): the user's program, proved once honestly and refused on two lying witnesses,
// offline. Not a recorded run; it checks the program and its host agree before any contract.
// usage: npx tsx experiments/26-x19-a-payment-rollup-with-nothing-held/smoke.ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Hex, bytesToHex } from 'viem'
import * as X from './x19.js'

const rnd = (): Hex => bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
const dir = mkdtempSync(join(tmpdir(), 'x19s-'))
const prog = X.writeProgram(join(dir, 'programs'))
const t: X.Transfer = { kh: rnd(), balance: 1_000_000n, amount: 250_000n, fee: 1_000n, s0: rnd(), s1: rnd(), r: rnd(), chan: rnd(), to: rnd(), expiry: rnd(), nullifier: rnd() }
const pub = X.publicOf(t)
const proofOut = join(dir, 'proof.bin')
const honest = X.proveTransfer(prog.path, X.inputOf(t, { proofOut }), 1)
console.log('honest', JSON.stringify(honest))
console.log('verify', JSON.stringify(X.verifyTransfer(prog.path, pub.D, proofOut)))
console.log('verify against another D', JSON.stringify(X.verifyTransfer(prog.path, X.H(pub.D, pub.D), proofOut)))
console.log('wrong new balance', JSON.stringify(X.proveTransfer(prog.path, X.inputOf(t, { newBalance: pub.newBalance + 1n }), 0)))
const over: X.Transfer = { ...t, amount: 2_000_000n }
console.log('overdraft, wrapped', JSON.stringify(X.proveTransfer(prog.path, X.inputOf(over, { newBalance: (1n << 64n) + over.balance - over.amount - over.fee }), 0)))
console.log('key', prog.key)
