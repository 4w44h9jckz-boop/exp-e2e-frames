// Experiment 20 (Q6), arms 2 and 4 for X9, on one chain: experiment 14's ExitVault with its
// reconciliation signed by named leanSPHINCS members (3 of 3) in place of the threshold BLS
// signature. Escape is opened as experiment 14's runner opens it: two notes held, an intent queued
// that nobody processes, TIMEOUT blocks of stall, then each holder's own redemption (experiment 14's
// x9-runner, Groth16 over the note). Then the refusals, the escape window, and the reconciliation.
// usage: npx tsx experiments/20-q6-committee-signatures/x9.ts <label> <local|testnet>
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Address, type Hex, concatHex, keccak256, pad, parseAbi, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { create2Address, deployFrame, saltOf } from '../../src/exp-frames/deploy.js'
import { Approve, type FrameTx, STORAGE_SET_STATE_GAS, senderFrame, verifyFrame } from '../../src/exp-frames/frametx/index.js'
import { type Row, openChain, root } from './chain.js'
import * as Q from './q6.js'

const [label, where] = process.argv.slice(2)
if (!label || !['local', 'testnet'].includes(where)) throw new Error('usage: x9.ts <label> <local|testnet>')
const RUNNER = process.env.X9_RUNNER ?? '/home/user/exp14/work/target-x9/release/x9-runner'
const exp14 = join(root, 'experiments/14-x9-exit-without-permission')
const c = await openChain(where as 'local' | 'testnet', label)
const { chainId, placement, privateKey } = c
const firstBlock = Number(await c.chain.getBlockNumber())
const fresh = (l: string): Address => privateKeyToAddress(keccak256(toHex(`${privateKey}/q6/${Q.DEPLOYMENT}/${label}/fresh/${l}`)))
const TIMEOUT = 10n
const ESCAPE_WINDOW = 10n
const FLOAT = 10n ** 16n
const DENOMINATION = 10n ** 15n
const vaultAbi = parseAbi(['function mode() view returns (uint256)', 'function escapeAt() view returns (uint256)', 'function redeemed() view returns (uint256)', 'function since() view returns (uint256)', 'function spent(bytes32) view returns (uint256)'])

// ---- the committee and the vault ----

const x9 = Q.committeeOf(privateKey, 'x9', 3)
for (const m of [...x9.members, x9.outsider]) c.secrets.push(Q.word(BigInt(`0x${Buffer.from(m.seed).toString('hex')}`)))
const keys = x9.members.map((m) => m.key)
const deployments = JSON.parse(readFileSync(join(exp14, 'rust/fixtures/deployments.json'), 'utf8')).contracts as { label: string; address: Address; target: Address; data: Hex; execution: number; state: number }[]
for (const d of deployments) {
  const code = await c.chain.getCode({ address: d.address })
  if (!code || code === '0x') await c.setupTx(`X9: deploy experiment 01's ${d.label}`, [senderFrame({ target: d.target, data: d.data, execution: BigInt(d.execution), state: BigInt(d.state) })])
}
const salt = saltOf(`exp-e2e-frames/20/${Q.DEPLOYMENT}/${label}/vault`)
// The committee in the BLS key's 256 bytes: three zero words, key 0..2, QUORUM, MEMBERS.
const region = [Q.word(0), Q.word(0), Q.word(0), ...keys, Q.word(3), Q.word(3)]
const initcode = concatHex([Q.codes.vault, pad('0x00', { size: 64 }), Q.word(ESCAPE_WINDOW), Q.word(TIMEOUT), ...region, pad(deployments[1].address), pad(deployments[0].address), Q.word(DENOMINATION), salt]).toLowerCase() as Hex
const vault = create2Address(initcode, salt)
await c.setupTx('X9: deploy the vault with its float', [{ ...deployFrame(initcode, salt).frame, value: FLOAT }])
const read = <T>(functionName: 'mode' | 'escapeAt' | 'redeemed' | 'since') => c.chain.readContract({ address: vault, abi: vaultAbi, functionName }) as Promise<T>

// ---- escape, as experiment 14 opens it ----

const env = { RPC_URL: c.url ?? process.env.RPC_URL ?? '', PRIVATE_KEY: c.funderKey } as NodeJS.ProcessEnv
const runner = (args: string[]) => {
  const out = execFileSync(RUNNER, args, { env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] })
  return JSON.parse(out.slice(out.indexOf('{')))
}
const secretDir = mkdtempSync(join(tmpdir(), 'q6-x9-'))
const notes = [0, 1].map((i) => join(secretDir, `note-${i}`))
const holds = notes.map((n) => runner(['hold', '--vault', vault, '--salt', salt, '--note', n]))
c.rows.push({ step: 'X9: two notes held', holds: holds.map((h) => ({ hash: h.hash, block: h.block, leaf: h.leaf })) })
const { encodeFunctionData } = await import('viem')
const intent = `0x${'ab'.repeat(116)}` as Hex
await c.setupTx('X9: an intent queued, which nobody processes', [senderFrame({ target: vault, data: encodeFunctionData({ abi: parseAbi(['function enqueue(bytes)']), functionName: 'enqueue', args: [intent] }), execution: 200_000n, state: 3n * STORAGE_SET_STATE_GAS })])
const since = await read<bigint>('since')
async function waitUntil(block: bigint) {
  while (BigInt(await c.chain.getBlockNumber()) < block) {
    if (where === 'local') await c.setupTx('a block', [senderFrame({ target: fresh('tick'), value: 1n, execution: 10_000n, state: 183_600n })]).catch(() => undefined)
    else await new Promise((r) => setTimeout(r, 3000))
  }
}
await waitUntil(since + TIMEOUT)
const redemptions = notes.map((n, i) => {
  const r = runner(['send-redemption', '--vault', vault, '--salt', salt, '--to', fresh(`holder/${i}`), '--seq', '0', '--note', n])
  const row = { step: `X9: holder ${i} redeems its own note`, hash: r.hash, nullifierHash: r.nonceKey, accepted: Boolean(r.node?.accepted), block: r.mined?.block, gasUsed: r.mined?.gasUsed, frames: r.mined?.frames, modeBefore: r.modeBefore, modeAfter: r.modeAfter }
  console.log(`${row.step}: ${row.hash} block ${row.block} mode ${row.modeBefore} -> ${row.modeAfter}`)
  c.rows.push(row)
  if (!row.accepted || r.mined?.status !== '0x1' && r.mined?.status !== 1) throw new Error(`${row.step}: ${JSON.stringify(r).slice(0, 400)}`)
  return row
})
rmSync(secretDir, { recursive: true, force: true })
const escapeAt = await read<bigint>('escapeAt')
if ((await read<bigint>('mode')) !== 1n) throw new Error('escape mode did not open')

// ---- the reconciliation ----

const list = redemptions.map((r) => BigInt(r.nullifierHash as string)).sort((a, b) => (a < b ? -1 : 1)).map((x) => Q.word(x))
const verifyWords = concatHex([Q.word(list.length), ...list])
const RECONCILE_TAG = keccak256(toHex('exp-e2e-frames/20/reconcile'))
const m = keccak256(concatHex([RECONCILE_TAG, Q.word(chainId), pad(vault), Q.word(escapeAt), keccak256(concatHex(list))]))
const nonceKey = BigInt(keccak256(concatHex([toHex('X9_RECONCILE'), Q.word(escapeAt)])))
function reconcileTx(triples: Hex, seq: bigint): FrameTx {
  const p = Q.placed(verifyWords, triples, placement)
  return {
    chainId, nonceKeys: [nonceKey], nonceSeq: seq, sender: vault,
    frames: [
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, data: p.verify, execution: 100_000n, state: STORAGE_SET_STATE_GAS }),
      ...p.between,
      senderFrame({ target: vault, data: '0x8f0d7e35', execution: 50_000n, state: 0n }),
    ],
    signatures: [], fees: Q.FEES, blobVersionedHashes: [],
  }
}
const observed: Row[] = []
const offChain: Row[] = []
async function step(name: string, signers: Q.Signer[], refusal?: string) {
  const signed = signers.map((s) => Q.L.sign(s.member.seed, Buffer.from(s.on.slice(2), 'hex')))
  const triples = Q.triplesOf(signers)
  if (!refusal) signers.forEach((s, i) => c.putWitness(Q.triple(s.on, s.member.key), signed[i]))
  const tx = reconcileTx(triples, 0n)
  const row = await c.frameStep(name, tx, { arm: 'x9', refusal: refusal ?? null, declared: c.declaredGas(signers.length), signatures: signers.length, signMs: signed.map((s) => s.signMs) }, Boolean(refusal))
  if (row.outcome === 'mined' && !refusal) {
    const r = Q.signersRead(tx, keys, (verifyWords.length - 2) / 2)
    observed.push({ arm: 'x9', step: name, hash: row.hash, frame: r.frame, signers: r.signers, distinctMessages: [...new Set(r.messages)].length })
    if (placement === 'modelled') offChain.push({ arm: 'x9', step: name, hash: row.hash, ...Q.aggregate(signed) })
  }
  return row
}
const by = (idx: number[], on = m): Q.Signer[] => idx.map((i) => ({ member: x9.members[i], on }))
await step('X9 refusal: a reconciliation with two signatures of three', by([0, 1]), 'below the quorum')
await step('X9 refusal: a reconciliation with member 1\'s signature declared twice', by([0, 1, 1]), 'one member counted twice')
await step('X9 refusal: a reconciliation with a key outside the committee as the third', [...by([0, 1]), { member: x9.outsider, on: m }], 'a key outside the committee')
await step('X9 refusal: a reconciliation with member 2\'s signature on another message', [...by([0, 1]), { member: x9.members[2], on: keccak256(toHex(`another/${escapeAt}`)) }], 'a signature on another message')
await waitUntil(escapeAt + ESCAPE_WINDOW)
await step('X9: the reconciliation signed by members 0, 1, 2', by([0, 1, 2]))
const after = { mode: await read<bigint>('mode'), redeemed: await read<bigint>('redeemed') }
console.log(`after the reconciliation: mode ${after.mode}`)

const lastBlock = Number(await c.chain.getBlockNumber())
c.stop()
c.write(`${label}-x9.json`, {
  experiment: 20, run: label, arm: 'x9', chain: where, placement, deployment: Q.DEPLOYMENT, repoCommit: c.repoCommit, chainId: Number(chainId), funder: c.funder, ethrex: c.ethrex ?? null,
  runner: { binary: 'experiment 14\'s x9-runner, built at f6bd932', modes: ['hold', 'send-redemption'] },
  vault, members: keys, quorum: 3, timeout: TIMEOUT, escapeWindow: ESCAPE_WINDOW, float: FLOAT, since, escapeAt, after,
  blocks: { first: firstBlock, last: lastBlock }, setup: c.setup.filter((s) => s.what !== 'a block'), ticks: c.setup.filter((s) => s.what === 'a block').length,
  rows: c.rows, observed, offChain,
  nodeRecords: where === 'local' ? { builds: c.jsonl('builds.jsonl'), checks: c.jsonl('checks.jsonl') } : null,
  transactions: c.txs,
})
process.exit(0)
