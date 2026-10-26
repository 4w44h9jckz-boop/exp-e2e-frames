// Experiment 14 (X9): the construction, checked offline before any transaction.
//
// - ExitVault.hex is ExitVault.yul compiled, and every selector and topic it hard-codes is the
//   keccak of the signature its comment names.
// - The committee's formats, as its Rust writes them (test/fixtures/x9/vectors.json, from
//   `exit-committee vectors`), read the same in an independent implementation: the intent opens
//   with the committee's key to the owner's key and B(s); each opening opens with the owner's key
//   to its member's part, in that member's windows; the parts OR to the nullifier; and the
//   recipient, the redemption digest, the reconcile message and its nonce key are recomputed.
// - The sealing is key-private in form: every message has the same length for its kind, carries a
//   fresh ephemeral key, and opens for no other key or AAD.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1'
import { type Hex, bytesToHex, concatHex, hexToBytes, keccak256, slice, toHex } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  INFO_INTENT,
  INFO_OPENING,
  INTENT_LEN,
  OPENING_LEN,
  SELECTORS,
  TOPICS,
  aad,
  enqueueData,
  open,
  readOpening,
  recipient,
  reconcileMessage,
  reconcileNonceKey,
  redemptionList,
  seal,
} from '../src/e2e/x9.js'

const here = new URL('../experiments/14-x9-exit-without-permission/', import.meta.url).pathname
const source = readFileSync(join(here, 'contracts/ExitVault.yul'), 'utf8')
const v = JSON.parse(readFileSync(new URL('./fixtures/x9/vectors.json', import.meta.url), 'utf8'))

const SIGNATURES: Record<string, string> = {
  deposit: 'deposit(bytes32)',
  withdraw: 'withdraw(bytes,bytes32,bytes32,address,address,uint256,uint256)',
  process: 'process(bytes32,bytes)',
  reconcile: 'reconcile()',
  enqueue: 'enqueue(bytes)',
  claim: 'claim(address)',
  republish: 'republish()',
  getLastRoot: 'getLastRoot()',
  nextIndex: 'nextIndex()',
  owed: 'owed(address)',
  sourceId: 'sourceId()',
  mode: 'mode()',
  head: 'head()',
  tail: 'tail()',
  since: 'since()',
  escapeAt: 'escapeAt()',
  spent: 'spent(bytes32)',
  knownRoot: 'knownRoot(bytes32)',
  intentAt: 'intentAt(uint256)',
  redeemed: 'redeemed()',
  committeeKey: 'committeeKey()',
  timeout: 'timeout()',
  escapeWindow: 'escapeWindow()',
}
const EVENTS: Record<string, string> = {
  Deposit: 'Deposit(bytes32,uint32,uint256)',
  Withdrawal: 'Withdrawal(address,bytes32,address,uint256)',
  FeeRefund: 'FeeRefund(address,uint256,uint256)',
  Intent: 'Intent(uint256,bytes)',
  Opening: 'Opening(uint256,bytes)',
  Escape: 'Escape(uint256,uint256)',
  Redeemed: 'Redeemed(bytes32,uint256)',
  Reconciled: 'Reconciled(uint256,uint256)',
  RecentRoot: 'RecentRoot(bytes32,uint64)',
}

describe('ExitVault', () => {
  it('ExitVault.hex is its Yul compiled by solc 0.8.37, EVM osaka, optimizer on, 200 runs', () => {
    const solc = createRequire(import.meta.url)('solc') as { compile(i: string): string; version(): string }
    expect(solc.version()).toMatch(/^0\.8\.37\+/)
    const input = {
      language: 'Yul',
      sources: { a: { content: source } },
      settings: { evmVersion: 'osaka', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['evm.bytecode.object'] } } },
    }
    const out = JSON.parse(solc.compile(JSON.stringify(input)))
    const [c] = Object.values(out.contracts.a) as { evm: { bytecode: { object: string } } }[]
    expect(`0x${c.evm.bytecode.object}`).toBe(readFileSync(join(here, 'contracts/ExitVault.hex'), 'utf8').trim())
  })

  it('every selector it dispatches on is its signature hash', () => {
    for (const [name, sig] of Object.entries(SIGNATURES)) {
      const sel = slice(keccak256(toHex(sig)), 0, 4)
      expect(SELECTORS[name as keyof typeof SELECTORS], sig).toBe(sel)
      expect(source, sig).toContain(sel)
    }
  })

  it('every topic it logs is its event hash', () => {
    for (const [name, sig] of Object.entries(EVENTS)) {
      const topic = keccak256(toHex(sig))
      expect(TOPICS[name as keyof typeof TOPICS], sig).toBe(topic)
      expect(source, sig).toContain(topic)
    }
  })

  it('the ABI file names every selector and topic', async () => {
    const { toEventSelector, toFunctionSelector } = await import('viem')
    const abi = JSON.parse(readFileSync(join(here, 'contracts/ExitVault.abi.json'), 'utf8'))
    const fns = abi.filter((x: { type: string }) => x.type === 'function').map((f: object) => toFunctionSelector(f as never))
    const evs = abi.filter((x: { type: string }) => x.type === 'event').map((e: object) => toEventSelector(e as never))
    for (const [name, sel] of Object.entries(SELECTORS)) if (name !== 'process' && name !== 'reconcile') expect(fns, name).toContain(sel)
    for (const [name, topic] of Object.entries(TOPICS)) expect(evs, name).toContain(topic)
  })

  it('the reconcile namespace and nonce-key prefix are the strings the README names', () => {
    expect(source).toContain(bytesToHex(new TextEncoder().encode('X9_RECONCILE_V1')).slice(2))
    expect(source).toContain(`${bytesToHex(new TextEncoder().encode('X9_RECONCILE')).slice(2)}0000000000000000000000000000000000000000`)
  })
})

describe('the committee formats, read again in TypeScript', () => {
  it('the intent opens with the committee key to the owner key and B(s)', () => {
    expect((v.sealedIntent.length - 2) / 2).toBe(INTENT_LEN)
    const p = open(v.committeeSecret, v.sealedIntent, INFO_INTENT, aad(v.vault, v.index))
    expect(p).toBe(concatHex([v.ownerKey, v.b]))
    expect(open(v.committeeSecret, v.sealedIntent, INFO_INTENT, aad(v.vault, v.index + 1))).toBeUndefined()
    expect(open(v.ownerSecret, v.sealedIntent, INFO_INTENT, aad(v.vault, v.index))).toBeUndefined()
    expect(keccak256(v.sealedIntent)).toBe(v.intentHash)
  })

  it('each opening opens with the owner key to its member part, and the parts make the nullifier', () => {
    const openings = hexToBytes(v.openings)
    expect(openings.length).toBe(3 * OPENING_LEN)
    const n = new Uint8Array(31)
    for (let j = 0; j < 3; j++) {
      const m = bytesToHex(openings.slice(j * OPENING_LEN, (j + 1) * OPENING_LEN))
      const p = open(v.ownerSecret, m, INFO_OPENING, aad(v.vault, v.index))
      expect(p, `opening ${j}`).toBeDefined()
      const o = readOpening(p as Hex)
      expect(o).toEqual({ part: v.parts[j], member: j, leaf: v.leaf, update: BigInt(v.index) })
      const part = hexToBytes(o.part)
      const windows = [
        [0, 21],
        [21, 42],
        [42, 62],
      ][j]
      for (let i = 0; i < 248; i++) {
        const set = (part[i >> 3] >> (i & 7)) & 1
        const w = i >> 2
        if (set) expect(w >= windows[0] && w < windows[1], `member ${j} bit ${i}`).toBe(true)
      }
      part.forEach((b, i) => {
        n[i] |= b
      })
      expect(open(v.committeeSecret, m, INFO_OPENING, aad(v.vault, v.index))).toBeUndefined()
    }
    expect(bytesToHex(n)).toBe(v.nullifier)
  })

  it('the recipient, digest, reconcile message and nonce key are recomputed', () => {
    expect(recipient(v.vault, v.intentHash, v.commitment, v.openings)).toBe(v.recipient)
    expect(redemptionList(v.nullifierHashes).digest).toBe(v.digest)
    expect(redemptionList(v.nullifierHashes).list).toEqual([...v.nullifierHashes].reverse())
    expect(reconcileMessage(8141, v.vault, v.escapeAt, v.digest)).toBe(v.reconcileMessage)
    expect(reconcileNonceKey(v.escapeAt)).toBe(v.reconcileNonceKey)
  })
})

describe('sealing', () => {
  it('seals and opens, one length per kind, a fresh ephemeral key each time, for its key and AAD only', () => {
    const owner = secp256k1.utils.randomPrivateKey()
    const other = secp256k1.utils.randomPrivateKey()
    const to = bytesToHex(secp256k1.getPublicKey(owner, true))
    const pt = bytesToHex(new Uint8Array(48).fill(7))
    const a = seal(to, pt, INFO_OPENING, aad(v.vault, 1))
    const b = seal(to, pt, INFO_OPENING, aad(v.vault, 1))
    expect((a.length - 2) / 2).toBe(OPENING_LEN)
    expect(slice(a, 2, 35)).not.toBe(slice(b, 2, 35))
    expect(open(bytesToHex(owner), a, INFO_OPENING, aad(v.vault, 1))).toBe(pt)
    expect(open(bytesToHex(other), a, INFO_OPENING, aad(v.vault, 1))).toBeUndefined()
    expect(open(bytesToHex(owner), a, INFO_INTENT, aad(v.vault, 1))).toBeUndefined()
    const intent = seal(v.committeeKey, concatHex([v.ownerKey, v.b]), INFO_INTENT, aad(v.vault, 2))
    expect((intent.length - 2) / 2).toBe(INTENT_LEN)
    expect((enqueueData(intent).length - 2) / 2).toBe(196)
  })
})
