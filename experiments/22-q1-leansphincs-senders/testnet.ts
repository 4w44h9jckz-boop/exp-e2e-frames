// Experiment 22 (Q1), arm 4: one rebuilt transaction of each shape, (a), (b) and (c), on the test
// network, with EIP-8288 modelled (README, "Two chains"). Each is the first one arm 2 mined with
// every frame succeeding, rebuilt by arm 2's rules, except where the test network differs:
// - it has no dependency frame, so the triple (0x10, 0, key) travels in the account's own VERIFY
//   data (contracts/SphincsAccountModelled.yul), and nothing on chain checks the signature, which
//   this run checks off chain with experiment 19's prover (verify-sphincs);
// - the sender's own code is already on chain, so the account's implementation is the original
//   sender's address (or its EIP-7702 delegate), and no contract is copied;
// - the funder (PRIVATE_KEY, secp256k1) deploys and funds each account in one call to the CREATE2
//   deployer, and sends nothing in a run's path.
// Each goes to skandha node A under the test network's profile, with node B booted from A.
//
// usage: npx tsx experiments/22-q1-leansphincs-senders/testnet.ts <n>-<label> <arm 2's record label>
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Address, type Hex, bytesToHex, concatHex, createWalletClient, getAddress, getContractAddress, http, keccak256, pad, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { type Node, type Pin, buildSkandha, checkout, linesNaming, loadKey, peersOf, rpcUrlOf, run, startNode, stopNode, until, writeConfig } from '../../src/e2e/index.js'
import { compileYul } from '../../src/exp-frames/contracts.js'
import { CREATE2_DEPLOYER } from '../../src/exp-frames/frametx/constants.js'
import { Approve, type Frame, type FrameTx, frameReceiptGas, frameReceiptStatus, frameSigHash, frameTxFromJson, frameTxHash, getNonceSeq, hegotaTestnet, makeClient, serializeFrameTx, simulateFrameTx, suggestFees, verifyFrame } from '../../src/exp-frames/frametx/index.js'
import * as L from '../19-x14-hash-based-stealth-addresses-under-8288/lean.js'
import * as X14 from '../19-x14-hash-based-stealth-addresses-under-8288/x14.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const DIR = 'experiments/22-q1-leansphincs-senders'
const [label, arm2] = process.argv.slice(2)
if (!label || !/^\d+-[a-z0-9-]+$/.test(label) || !arm2) throw new Error("usage: testnet.ts <n>-<label> <arm 2's record label>")
mkdirSync(join(here, 'results'), { recursive: true })
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8')) as Record<string, Pin>
const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
const dirty = (await run('git', ['status', '--porcelain', '--', DIR, 'src'], { cwd: root })).trim()
if (dirty) throw new Error(`commit the experiment before a recorded run:\n${dirty}`)
const { privateKey, address: funder } = loadKey()
const secrets: string[] = [privateKey]
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const lower = (a: string) => a.toLowerCase()
const ZERO32 = `0x${'00'.repeat(32)}` as Hex
const FUND = 10n ** 16n // 0.01 ETH, beyond each transaction's value

const testnet = makeClient()
const chainId = BigInt(await testnet.getChainId())
const wallet = createWalletClient({ account: privateKeyToAccount(privateKey), chain: hegotaTestnet, transport: http() })
const record2 = JSON.parse(readFileSync(join(here, 'results', `${arm2}.json`), 'utf8')) as { rows: Json[] }
const picks = (['a', 'b', 'c'] as const).map((s) => record2.rows.find((r) => r.shape === s && r.outcome === 'mined' && !(r.changes as string[]).some((c) => c.startsWith('blobs') || c.startsWith('creation')))).filter(Boolean) as Json[]
console.log(`picked ${picks.map((p) => `${p.shape}: ${p.record}`).join(', ')}`)

const initcodeOf = compileYul(`${DIR}/contracts/SphincsAccountModelled.yul`)
const rpcT = (method: string, params: unknown[]) => testnet.request({ method, params } as never) as Promise<Json>

// ---- the accounts, deployed and funded by the funder, once each ----

type Account = { old: Address; address: Address; key: Hex; seed: Uint8Array; impl: Address | null; implSource: string; salt: Hex; initcode: Hex }
const setup: Json[] = []
const built: { pick: Json; tx: Json; receipt: Json; a: Account; frames: Frame[]; nonceKeys: bigint[]; fees: FrameTx['fees']; verifyIndex: number; changes: string[] }[] = []
for (const p of picks) {
  const tx = await rpcT('eth_getTransactionByHash', [p.record])
  const receipt = await rpcT('eth_getTransactionReceipt', [p.record])
  const old = getAddress(tx.type === '0x6' ? tx.sender : tx.from)
  const seed = crypto.getRandomValues(new Uint8Array(32))
  secrets.push(bytesToHex(seed))
  const key = bytesToHex(L.sphincsKey(seed)) as Hex
  const oldCode = (await testnet.getCode({ address: old })) ?? '0x'
  const impl = oldCode.startsWith('0xef0100') ? getAddress(`0x${oldCode.slice(8, 48)}`) : oldCode !== '0x' ? old : null
  const implSource = oldCode.startsWith('0xef0100') ? `EIP-7702 delegate ${impl}` : impl ? "the original sender's own code, at its address" : 'none: a codeless sender'
  const initcode = concatHex([initcodeOf, pad(impl ?? '0x', { size: 32 }), key])
  const salt = keccak256(toHex(`experiment 22/arm 4/${label}/${p.shape}`))
  const address = getContractAddress({ opcode: 'CREATE2', from: CREATE2_DEPLOYER, salt, bytecode: initcode })
  const a: Account = { old, address, key, seed, impl, implSource, salt, initcode }
  const value = tx.type === '0x6' ? (frameTxFromJson(tx as never).frames.reduce((s, f) => s + f.value, 0n)) : BigInt(tx.value)
  const hash = await wallet.sendTransaction({ to: CREATE2_DEPLOYER, value: FUND + value, data: concatHex([salt, initcode]) })
  const rc = await testnet.waitForTransactionReceipt({ hash, timeout: 180_000 })
  const deployed = (await testnet.getCode({ address })) ?? '0x'
  setup.push({ shape: p.shape, funder, hash, status: rc.status, gasUsed: Number(rc.gasUsed), account: address, deployed: deployed !== '0x', value: (FUND + value).toString() })
  console.log(`funder deploys and funds the (${p.shape}) account ${address}: ${hash} ${rc.status} ${rc.gasUsed} gas`)

  // Arm 2's rules (amendments 3 and 4), with the triple in VERIFY's data and no dependency frame.
  const changes: string[] = []
  let subs = 0
  const re = new RegExp(old.slice(2), 'gi')
  const keep = (f: Frame): Frame => {
    const target = f.target && lower(f.target) === lower(old) ? address : f.target
    if (target !== f.target) subs++
    subs += (f.data.match(re) ?? []).length
    return { ...f, target, data: f.data.replace(re, address.slice(2).toLowerCase()) as Hex }
  }
  const triple = X14.triple(X14.LEANSPHINCS_SCHEME, ZERO32, key)
  let frames: Frame[]
  let nonceKeys = [0n]
  let fees: FrameTx['fees']
  let verifyIndex = 0
  if (tx.type === '0x6') {
    const ft = frameTxFromJson(tx as never)
    if (lower(frameTxHash(ft)) !== lower(tx.hash)) throw new Error(`${tx.hash}: does not re-encode to its hash`)
    const last = Math.max(...ft.frames.map((f, k) => (f.mode === 1 && (f.flags & 3) !== 0 ? k : -1)))
    let verifyState = 0n
    const prefix: Frame[] = []
    ft.frames.slice(0, last + 1).forEach((f) => {
      if (f.mode === 1 && (f.flags & 3) !== 0) {
        if (f.target === null || lower(f.target) === lower(ft.sender)) verifyState = f.limits.state > verifyState ? f.limits.state : verifyState
        else changes.push('payer: the account pays for itself')
        return
      }
      if (f.mode === 0 && f.target && lower(f.target) === lower(CREATE2_DEPLOYER) && f.data.length >= 66) {
        const made = getContractAddress({ opcode: 'CREATE2', from: CREATE2_DEPLOYER, salt: `0x${f.data.slice(2, 66)}` as Hex, bytecode: `0x${f.data.slice(66)}` as Hex })
        if (lower(made) === lower(ft.sender)) return
      }
      prefix.push(keep(f))
    })
    const verify = verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, data: triple, execution: 30_000n, state: verifyState })
    frames = [...prefix, verify, ...ft.frames.slice(last + 1).map(keep)]
    verifyIndex = prefix.length
    nonceKeys = ft.nonceKeys
    fees = ft.fees
  } else {
    let target: Address = getAddress(tx.to)
    if (lower(target) === lower(old)) { target = address; subs++ }
    subs += ((tx.input ?? '0x').match(re) ?? []).length
    const data = (tx.input ?? '0x').replace(re, address.slice(2).toLowerCase()) as Hex
    const gas = BigInt(tx.gas)
    frames = [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, data: triple, execution: 30_000n, state: 0n }), { mode: 2, flags: 0, target, limits: { execution: gas, state: gas }, value: BigInt(tx.value), data }]
    fees = { maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas ?? tx.gasPrice), maxFeePerGas: BigInt(tx.maxFeePerGas ?? tx.gasPrice), maxFeePerBlobGas: 0n }
  }
  // Fees follow the network's base fee today, not the record's day; they are not a frame.
  const now = await suggestFees(testnet, fees.maxPriorityFeePerGas)
  if (now.maxFeePerGas > fees.maxFeePerGas) { fees = { ...fees, maxFeePerGas: now.maxFeePerGas }; changes.push("fees: today's base fee") }
  if (subs) changes.push(`sender's address: ${subs} place(s) in the copied frames`)
  built.push({ pick: p, tx, receipt, a, frames, nonceKeys, fees, verifyIndex, changes })
}

// ---- nodes A and B on the test network ----

const skandha = await checkout('skandha', pins.skandha, join(root, 'work'))
await buildSkandha(skandha)
const work = join(root, 'work')
const stamp = Date.now()
const config = join(work, `q1-arm4-${stamp}.json`)
writeConfig(config)
const nodes: Node[] = []
const rows: Json[] = []
try {
  const a = await startNode({ dir: skandha, name: 'A', config, dataDir: join(work, `a-${stamp}`), apiPort: 15337, wsPort: 15437, p2pPort: 15000, log: join(work, `a-${stamp}.frames.jsonl`), out: join(work, `a-${stamp}.out`), handoff: true })
  nodes.push(a)
  const b = await startNode({ dir: skandha, name: 'B', config, dataDir: join(work, `b-${stamp}`), apiPort: 15338, wsPort: 15438, p2pPort: 15001, log: join(work, `b-${stamp}.frames.jsonl`), out: join(work, `b-${stamp}.out`), bootEnr: a.enr, handoff: true })
  nodes.push(b)
  await until('nodes A and B to peer', async () => {
    const [pa, pb] = await Promise.all([peersOf(a), peersOf(b)])
    return pa.includes(b.peerId) && pb.includes(a.peerId) ? true : undefined
  }, 120_000)

  for (const x of built) {
    const nonceSeq = await getNonceSeq(testnet, x.a.address, x.nonceKeys)
    const tx: FrameTx = { chainId, nonceKeys: x.nonceKeys, nonceSeq, sender: x.a.address, frames: x.frames, signatures: [], fees: x.fees, blobVersionedHashes: [] }
    const sighash = frameSigHash(tx)
    const signed = L.sign(x.a.seed, Buffer.from(sighash.slice(2), 'hex'))
    // Modelled: nothing on the test network checks it, so the run does, as a node would.
    const offChain = JSON.parse(execFileSync(L.PROVER, ['verify-sphincs', signed.publicKey, sighash, signed.signature], { encoding: 'utf8' }).trim().split('\n').pop()!) as Json
    const sim = (await simulateFrameTx(testnet, tx).catch((e) => ({ error: String(e).slice(0, 300) }))) as Json
    const raw = serializeFrameTx(tx)
    const hash = frameTxHash(tx)
    const res = await fetch(rpcUrlOf(a), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }) })
    const body = (await res.json()) as { result?: string; error?: unknown }
    const nodeA = body.error ? `refused: ${JSON.stringify(body.error).slice(0, 300)}` : `admitted: ${body.result}`
    let rc: Json | null = null
    if (nodeA.startsWith('admitted')) {
      const t0 = Date.now()
      while (!rc && Date.now() - t0 < 180_000) { rc = await rpcT('eth_getTransactionReceipt', [hash]); if (!rc) await new Promise((r) => setTimeout(r, 3000)) }
    }
    const frames = rc ? (rc.frameReceipts as Json[]).map((f) => ({ status: frameReceiptStatus(f as never), execution: Number(frameReceiptGas(f as never).execution), state: Number(frameReceiptGas(f as never).state) })) : []
    rows.push({
      shape: x.pick.shape, experiment: x.pick.experiment, record: x.pick.record, recordGasUsed: Number(BigInt(x.receipt.gasUsed)), arm2GasUsed: x.pick.prediction5?.gasUsed ?? null,
      sender: { old: x.a.old, new: x.a.address }, implementation: x.a.implSource, changes: x.changes,
      hash, bytes: (raw.length - 2) / 2, simulation: { valid: sim.valid, violation: sim.violation, executionStatus: sim.executionStatus, gasUsed: sim.gasUsed, error: sim.error },
      signature: { bytes: (signed.signature.length - 2) / 2, signMs: Math.round(signed.signMs), offChain },
      nodeA, seen: { A: linesNaming(a.log, hash).length, B: linesNaming(b.log, hash).length },
      outcome: rc ? (frames.every((f) => f.status === 1) ? 'mined' : 'mined, a frame failed') : nodeA.startsWith('admitted') ? 'not mined in 180 s' : 'refused at node A',
      block: rc ? Number(BigInt(rc.blockNumber)) : null, gasUsed: rc ? Number(BigInt(rc.gasUsed)) : null, frames, verifyGas: frames[x.verifyIndex]?.execution ?? null,
    })
    console.log(`(${x.pick.shape}) ${hash}: node A ${nodeA.slice(0, 120)}; ${rows[rows.length - 1].outcome}${rc ? ` at ${rows[rows.length - 1].gasUsed} gas` : ''}; signature off chain ${JSON.stringify(offChain)}`)
  }
} finally {
  for (const n of nodes) await stopNode(n.child)
}

const record = {
  experiment: 22, arm: 4, run: label, date: new Date().toISOString(), repoCommit, pins, arm2: `results/${arm2}.json`,
  command: `npx tsx ${DIR}/testnet.ts ${label} ${arm2}`,
  chain: { chainId: Number(chainId), rpc: 'https://rpc1.privacy.ethrex.xyz', eip8288: 'modelled: the triple in VERIFY data, the signature checked off chain' },
  setup, rows,
  summary: { shapes: rows.length, admittedAtNodeA: rows.filter((r) => String(r.nodeA).startsWith('admitted')).length, receivedByB: rows.filter((r) => r.seen.B > 0).length, mined: rows.filter((r) => r.block !== null).length, signaturesVerified: rows.filter((r) => r.signature.offChain.verified === true).length },
}
let text = JSON.stringify(record, null, 2)
for (const s of secrets) if (text.toLowerCase().includes(s.slice(2).toLowerCase())) throw new Error('a secret would be recorded')
text += '\n'
writeFileSync(join(here, 'results', `${label}.json`), text)
console.log(`recorded results/${label}.json: ${JSON.stringify(record.summary)}`)
process.exit(0)
