// Experiment 15 (X10): a note out to an AMM and back, R0 to R3 and the refusals, on the test
// network. Setup (deployments, liquidity, floats, deposits) goes to the chain directly; every
// step after it goes to skandha node A, which gossips it to node B, which alone hands it to the
// chain. Every step is simulated first, and sent only if the simulation says what the step
// expects. The record is written to results/<n>-<label>.json after a search for every secret.
//
// usage: X10_DEPLOYMENT=<tag> npx tsx experiments/15-x10-out-and-back/run.ts <n>-<label>
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Address, type Hex, concatHex, encodeFunctionData, getAddress, hexToBigInt, keccak256, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { type Node, type Pin, buildSkandha, checkout, linesNaming, loadKey, peersOf, rpcUrlOf, run, startNode, stopNode, until, writeConfig } from '../../src/e2e/index.js'
import { sendFrames } from '../../src/exp-frames/deploy.js'
import { type FrameTx, frameReceiptGas, frameReceiptStatus, makeClient, sendFrameTx, simulateFrameTx, waitForFrameTxReceipt } from '../../src/exp-frames/frametx/index.js'
import { committeeProve, loopback } from './committee.js'
import * as X from './x10.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const work = join(root, 'work')
const runLabel = process.argv[2]
if (!runLabel || !/^\d+-[a-z0-9-]+$/.test(runLabel)) throw new Error('usage: run.ts <n>-<label>')
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8')) as Record<string, Pin>
const { privateKey, address: funder } = loadKey()
const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
const dirty = (await run('git', ['status', '--porcelain', '--', 'experiments/15-x10-out-and-back', 'src'], { cwd: root })).trim()
if (dirty) throw new Error(`commit the experiment before a recorded run:\n${dirty}`)

const chain = makeClient()
const chainId = BigInt(await chain.getChainId())
const tagOut = X.tagOf(X.token.address)
const fresh = (l: string): Address => privateKeyToAddress(keccak256(concatHex([privateKey, toHex(`exp-e2e-frames/15/${X.DEPLOYMENT}/recipient/${l}`)])))
const secretsOf = (l: string) => X.secretsOf(privateKey, l)

type Row = Record<string, unknown>
const rows: Row[] = []
const setup: Row[] = []
const secretStrings: string[] = [privateKey]
const note = (s: X.Secrets) => { secretStrings.push(s.nullifierSecret.toString(16), s.secret.toString(16), s.nullifierSecret.toString(), s.secret.toString()); return s }

// ---- set-up, to the chain directly ----

// The testnet's RPC can drop a transaction it acknowledged. A set-up transaction that gets no
// receipt is sent again once, if the funder's nonce shows it never landed.
async function setupTx(what: string, frames: Parameters<typeof sendFrames>[2]) {
  for (let attempt = 1; ; attempt++) {
    const nonce = await chain.getTransactionCount({ address: funder, blockTag: 'latest' })
    try {
      const r = await sendFrames(chain, privateKey, frames, { label: what })
      if (!r?.hash || !r.receipt) throw new Error(`${what}: not mined`)
      const ok = r.receipt.frameReceipts.every((f) => frameReceiptStatus(f) === 1)
      setup.push({ what, hash: r.hash, block: Number(BigInt(r.receipt.blockNumber)), gasUsed: Number(BigInt(r.receipt.gasUsed)), ok, attempt })
      if (!ok) throw new Error(`${what}: a frame failed`)
      // Wait for a node that has the transaction's effects before the next simulation.
      await X.settled(`${what}: the funder's nonce`, async () => ((await chain.getTransactionCount({ address: funder, blockTag: 'latest' })) > nonce ? true : undefined))
      return
    } catch (e) {
      const msg = (e as Error).message
      if (attempt > 1 || !msg.startsWith('no receipt')) throw e
      if ((await chain.getTransactionCount({ address: funder, blockTag: 'latest' })) !== nonce) throw e
      console.log(`${what}: no receipt and the nonce has not moved; sending again`)
    }
  }
}

console.log(`deployment ${X.DEPLOYMENT}: tree registry ${X.treeRegistry.address}, append registry ${X.appendRegistry.address}, amm ${X.amm.address}`)
const contracts = [...Object.values(X.verifiers), X.token, X.amm, X.relay, ...Object.values(X.probes), X.treeRegistry, X.appendRegistry]
for (const c of contracts) {
  const code = await chain.getCode({ address: c.address })
  if (code && code !== '0x') throw new Error(`${c.label} is already deployed: set X10_DEPLOYMENT to a fresh tag`)
}
if (!(await chain.getCode({ address: X.HASHER }))) throw new Error('experiment 06\'s hasher is not on the chain')
for (const c of contracts) await setupTx(`deploy ${c.label}`, [c.deploy])
// The registries answer, in the mode they were built for, before anything is sent to them.
for (const r of [X.treeRegistry, X.appendRegistry]) {
  const mode = await X.settled(`${r.label}: mode()`, async () => BigInt(await chain.readContract({ address: r.address, abi: X.registryAbi, functionName: 'mode' })))
  if (mode !== r.mode) throw new Error(`${r.label} answers mode ${mode}, not ${r.mode}`)
}

const LIQUIDITY_ETH = 2n * 10n ** 16n
const LIQUIDITY_TOKEN = 10n ** 24n
await setupTx('liquidity: the token minted to the pool, and ether', [
  X.callFrame(X.token.address, encodeFunctionData({ abi: X.tokenAbi, functionName: 'mint', args: [X.amm.address, LIQUIDITY_TOKEN] })),
  X.callFrame(X.amm.address, encodeFunctionData({ abi: X.ammAbi, functionName: 'addEther' }), LIQUIDITY_ETH),
])
const FLOAT = 10n ** 16n
await setupTx('a float for each registry', [X.callFrame(X.treeRegistry.address, '0x', FLOAT, 50_000n, 0n), X.callFrame(X.appendRegistry.address, '0x', FLOAT, 50_000n, 0n)])

// The notes. Tree registry: R0, R1, the slippage case and the four misbehaving destinations.
// Append registry: R2, the round's four, and three more to fill the first batch.
const treeNotes = ['r0', 'r1', 'slip', ...X.PROBES.map((p) => `probe-${p}`)]
const appendNotes = ['r2', 'round0', 'round1', 'round2', 'round3', 'fill0', 'fill1', 'fill2']
for (const l of [...treeNotes, ...appendNotes]) note(secretsOf(l))
for (const l of treeNotes) await setupTx(`deposit ${l} into the tree registry`, [X.depositFrame(X.treeRegistry, X.innerOf(secretsOf(l)), X.DENOMINATION)])
await setupTx('deposit eight notes into the append registry', appendNotes.map((l) => X.depositFrame(X.appendRegistry, X.innerOf(secretsOf(l)), X.DENOMINATION)))
for (const [r, n] of [[X.treeRegistry, treeNotes.length], [X.appendRegistry, appendNotes.length]] as const) {
  const count = await X.read(chain, r, 'leafCount')
  if (count !== BigInt(n)) throw new Error(`${r.label} holds ${count} leaves, not ${n}`)
}

// ---- the nodes ----

const skandha = await checkout('skandha', pins.skandha, work)
const cosnarks = await checkout('co-snarks', pins['co-snarks'], work)
await buildSkandha(skandha)
const cocircom = join(work, 'target-cocircom', 'release', 'co-circom')
await run('cargo', ['build', '-q', '--release', '--bin', 'co-circom'], { cwd: cosnarks, env: { CARGO_TARGET_DIR: join(work, 'target-cocircom') } })

const stamp = Date.now()
const config = join(work, `x10-${stamp}.json`)
writeConfig(config)
const nodes: Node[] = []
const secrets = mkdtempSync(join(tmpdir(), 'x10-'))
let nodeA: ReturnType<typeof makeClient> | undefined
const out: Record<string, unknown> = {}

try {
  const a = await startNode({ dir: skandha, name: 'A', config, dataDir: join(work, `a-${stamp}`), apiPort: 15337, wsPort: 15437, p2pPort: 15000, log: join(work, `a-${stamp}.frames.jsonl`), out: join(work, `a-${stamp}.out`) })
  nodes.push(a)
  const b = await startNode({ dir: skandha, name: 'B', config, dataDir: join(work, `b-${stamp}`), apiPort: 15338, wsPort: 15438, p2pPort: 15001, log: join(work, `b-${stamp}.frames.jsonl`), out: join(work, `b-${stamp}.out`), bootEnr: a.enr, handoff: true })
  nodes.push(b)
  await until('the two nodes to peer, each with the other alone', async () => {
    const [pa, pb] = await Promise.all([peersOf(a), peersOf(b)])
    return pa.length === 1 && pa[0] === b.peerId && pb.length === 1 && pb[0] === a.peerId ? true : undefined
  }, 120_000)
  nodeA = makeClient(rpcUrlOf(a))
  console.log(`A ${a.peerId}, B ${b.peerId}: peered`)

  const logsOf = (log: string, hash: string) => linesNaming(readFileSync(log, 'utf8'), hash).map((l) => ({ msg: l.msg, ...(l.reason ? { reason: l.reason } : {}) }))

  /** Simulate; if it says what `expect` says, send to node A; for a mined step, wait for it. */
  async function step(name: string, tx: FrameTx, expect: 'mined' | 'refused', extra: Row = {}) {
    // A node that lags may not have the root or the leaves yet: for a step that should be mined,
    // simulate again for a while before calling it refused.
    let sim = await simulateFrameTx(chain, tx)
    for (let i = 0; expect === 'mined' && (!sim.valid || sim.executionStatus !== 'success') && i < 10; i++) {
      await new Promise((res) => setTimeout(res, 6_000))
      sim = await simulateFrameTx(chain, tx)
    }
    const simRow = { valid: sim.valid, violation: sim.violation, executionStatus: sim.executionStatus, gasUsed: sim.gasUsed ? Number(BigInt(sim.gasUsed)) : null, frames: sim.frames?.map((f) => ({ gasUsed: Number(BigInt(f.gasUsed)), succeeded: f.succeeded })) }
    if (expect === 'refused') {
      if (sim.valid) throw new Error(`${name}: expected a refusal, but simulation admits it (${JSON.stringify(simRow)})`)
      let node = 'admitted'
      try {
        await sendFrameTx(nodeA!, tx)
      } catch (e) {
        node = (e as Error).message.split('\n')[0].slice(0, 200)
      }
      if (node === 'admitted') throw new Error(`${name}: node A admitted what simulation refused`)
      console.log(`${name}: refused (${sim.violation}); node A: ${node}`)
      rows.push({ step: name, expect, outcome: 'refused', simulation: simRow, nodeA: node, ...extra })
      return undefined
    }
    if (!sim.valid || sim.executionStatus !== 'success') throw new Error(`${name}: simulation does not admit it: ${JSON.stringify(simRow)}`)
    const hash = await sendFrameTx(nodeA!, tx)
    const r = await waitForFrameTxReceipt(chain, hash, { timeoutMs: 180_000 })
    const frames = r.frameReceipts.map((f) => ({ status: frameReceiptStatus(f), ...frameReceiptGas(f) }))
    const ok = frames.every((f) => f.status === 1)
    const row = { step: name, expect, outcome: ok ? 'mined' : 'mined, a frame failed', hash, block: Number(BigInt(r.blockNumber)), gasUsed: Number(BigInt(r.gasUsed)), frames: frames.map((f) => ({ status: f.status, execution: Number(f.execution), state: Number(f.state) })), simulation: simRow, nodeA: logsOf(a.log, hash), nodeB: logsOf(b.log, hash), ...extra }
    console.log(`${name}: ${hash} block ${row.block} gasUsed ${row.gasUsed} frames ${frames.map((f) => `${f.status}:${f.execution}+${f.state}s`).join(' / ')}`)
    rows.push(row)
    if (!ok) throw new Error(`${name}: a frame failed`)
    return { hash, block: BigInt(r.blockNumber), blockHash: r.blockHash as Hex }
  }

  /** The registry's events in one transaction. */
  async function eventsIn(r: X.Registry, hash: Hex, blockHash: Hex) {
    // Every transaction a registry sends logs something; wait for a node that has the block.
    await X.settled('the transaction\'s logs', async () => {
      const logs = await chain.getLogs({ address: r.address, blockHash } as never)
      return (logs as unknown as { transactionHash: Hex }[]).some((l) => l.transactionHash === hash) ? true : undefined
    })
    type Picked = { transactionHash: Hex; args: Record<string, unknown> }
    const pick = async <E extends (typeof X.EVENTS)[keyof typeof X.EVENTS]>(event: E) => ((await chain.getLogs({ address: r.address, event, blockHash } as never)) as unknown as Picked[]).filter((l) => l.transactionHash === hash)
    return {
      completed: (await pick(X.EVENTS.completed)).map((l) => ({ partial: hexToBigInt(l.args.partialNote as Hex), value: l.args.value as bigint, leaf: hexToBigInt(l.args.leaf as Hex) })),
      receipts: (await pick(X.EVENTS.receipt)).map((l) => ({ id: hexToBigInt(l.args.receiptId as Hex), value: hexToBigInt(l.args.value as Hex), commitmentHash: hexToBigInt(l.args.commitmentHash as Hex) })),
      refunded: (await pick(X.EVENTS.refunded)).map((l) => ({ nullifier: hexToBigInt(l.args.nullifier as Hex), refund: hexToBigInt(l.args.refund as Hex) })),
      appended: (await pick(X.EVENTS.appended)).map((l) => ({ leaf: hexToBigInt(l.args.leaf as Hex), index: Number(l.args.index) })),
    }
  }

  /** The tree a spend proves against: every leaf (MODE 0), or the batched ones (MODE 1). */
  async function treeFor(r: X.Registry) {
    // The logs, the counters and the root can come from nodes that lag one another: wait until
    // they agree, with the leaf count the registry reports.
    return X.settled(`the ${r.label} tree`, async () => {
      const count = Number(await X.read(chain, r, 'leafCount'))
      const all = await X.leavesOf(chain, r)
      if (all.length !== count) return undefined
      const leaves = r.mode === X.MODE.TREE ? all : all.slice(0, Number(await X.read(chain, r, 'batchedCount')))
      const tree = X.treeOf(leaves)
      if ((await X.read(chain, r, 'root')) !== tree.root) return undefined
      const slot = await X.rootSlot(chain, r, tree.root)
      if (slot === undefined) return undefined
      return { all, leaves, tree, slot }
    })
  }
  const indexOf = (leaves: bigint[], leaf: bigint) => {
    const i = leaves.indexOf(leaf)
    if (i < 0) throw new Error('the note is not in the tree it proves against')
    return i
  }
  const proving: Row = {}

  /** A spend of an ether note of the denomination, out to `destination`. */
  async function exportSpend(name: string, r: X.Registry, l: string, how: bigint, destination: Address, minOut: bigint, expect: 'mined' | 'refused' = 'mined') {
    const { leaves, tree, slot } = await treeFor(r)
    const s = secretsOf(l)
    const outSecrets = note(secretsOf(`${l}/out`))
    const refundSecrets = note(secretsOf(`${l}/refund`))
    const innerOut = X.innerOf(outSecrets)
    const partial = how === X.How.RECEIPT ? X.H(tagOut, innerOut) : innerOut
    const sp = await X.spendWords({ tag: X.ETH_TAG, secrets: s, value: X.DENOMINATION, index: indexOf(leaves, X.leafOf(X.ETH_TAG, X.innerOf(s), X.DENOMINATION)), amountOut: X.DENOMINATION, refundInner: X.innerOf(refundSecrets), how, to: destination, fee: X.FEE, tagOut, partial, minOut }, tree)
    proving[name] = sp.ms
    const tx = X.spendTx({ chainId, r, slot, root: sp.root, words: sp.words })
    const done = await step(name, tx, expect, { registry: r.address, how: Number(how), destination, minOut: minOut.toString(), nullifier: `0x${sp.nullifier.toString(16)}`, calldataBytes: (tx.frames[2].data.length - 2) / 2 })
    return done ? { ...done, events: await eventsIn(r, done.hash, done.blockHash), outSecrets, refundSecrets, nullifier: sp.nullifier } : undefined
  }

  /** A payout of a whole note to a fresh recipient: ether less the fee, or the token whole. */
  async function payout(name: string, r: X.Registry, tag: bigint, s: X.Secrets, value: bigint, to: Address) {
    const { leaves, tree, slot } = await treeFor(r)
    const fee = tag === X.ETH_TAG ? X.FEE : 0n
    const sp = await X.spendWords({ tag, secrets: s, value, index: indexOf(leaves, X.leafOf(tag, X.innerOf(s), value)), amountOut: value, how: X.How.PAYOUT, to, fee }, tree)
    proving[name] = sp.ms
    const done = await step(name, X.spendTx({ chainId, r, slot, root: sp.root, words: sp.words }), 'mined', { registry: r.address, recipient: to })
    const balance = tag === X.ETH_TAG ? await chain.getBalance({ address: to }) : BigInt(await chain.readContract({ address: X.token.address, abi: X.tokenAbi, functionName: 'balanceOf', args: [to] }))
    rows.at(-1)!.recipientBalance = balance.toString()
    return done
  }

  const quote = async (amountIn: bigint) => BigInt(await chain.readContract({ address: X.amm.address, abi: X.ammAbi, functionName: 'quote', args: [amountIn] }))
  const minOutFor = async (amountIn: bigint) => ((await quote(amountIn)) * 95n) / 100n
  const IN = X.DENOMINATION - X.FEE

  // ---- R0: the draft's bridge. Spend and export; the AMM registers a receipt; claim it. ----
  const r0 = await exportSpend('R0a: spend and export, the AMM registers a receipt', X.treeRegistry, 'r0', X.How.RECEIPT, X.amm.address, await minOutFor(IN))
  const receipt = r0!.events.receipts[0]
  if (!receipt) throw new Error('R0a: no receipt')
  const claim = await X.claimWords(tagOut, X.innerOf(r0!.outSecrets), receipt.value)
  proving['R0b'] = claim.ms
  if (claim.id !== receipt.id) throw new Error('R0b: the receipt id does not match')
  const r0b = await step('R0b: claim the receipt with a second proof', X.claimTx({ chainId, r: X.treeRegistry, words: claim.words }), 'mined', { receiptId: `0x${claim.id.toString(16)}`, value: receipt.value.toString() })
  out.r0 = { receiptValue: receipt.value.toString(), blocks: Number(r0b!.block - r0!.block) }

  // ---- R1: one transaction; the AMM calls back and completes the partial note. ----
  const r1 = await exportSpend('R1: spend, export, swap and the new note in one transaction', X.treeRegistry, 'r1', X.How.COMPLETE, X.amm.address, await minOutFor(IN))
  const r1Out = r1!.events.completed[0]
  if (!r1Out) throw new Error('R1: no completion')

  // ---- prediction 3: a swap that cannot meet its minimum returns the input ----
  const slip = await exportSpend('F3: a minimum the pool cannot meet', X.treeRegistry, 'slip', X.How.COMPLETE, X.amm.address, (await quote(IN)) * 10n)
  if (slip!.events.refunded.length !== 1 || slip!.events.completed.length) throw new Error('F3: expected a refund and no completion')

  // ---- prediction 2: the call-back cannot be abused ----
  const abuse: Row = {}
  for (const p of X.PROBES) {
    const before = BigInt(await chain.readContract({ address: X.token.address, abi: X.tokenAbi, functionName: 'balanceOf', args: [X.treeRegistry.address] }))
    const ethBefore = await chain.getBalance({ address: X.probes[p].address })
    const res = await exportSpend(`F2-${p}: a destination that misbehaves (${p})`, X.treeRegistry, `probe-${p}`, X.How.COMPLETE, X.probes[p].address, 1000n)
    const after = BigInt(await chain.readContract({ address: X.token.address, abi: X.tokenAbi, functionName: 'balanceOf', args: [X.treeRegistry.address] }))
    abuse[p] = { refunded: res!.events.refunded.length, completed: res!.events.completed.length, registryTokenDelta: (after - before).toString(), probeEtherDelta: ((await chain.getBalance({ address: X.probes[p].address })) - ethBefore).toString() }
    if (res!.events.refunded.length !== 1 || res!.events.completed.length) throw new Error(`F2-${p}: expected a refund and no completion`)
  }
  try {
    await chain.call({ account: funder, to: X.treeRegistry.address, data: encodeFunctionData({ abi: X.registryAbi, functionName: 'completeImport', args: [1000n] }) })
    throw new Error('F2-outside: a completion outside any export was accepted')
  } catch (e) {
    if ((e as Error).message.startsWith('F2-outside')) throw e
    abuse.outside = 'reverted'
  }
  out.abuse = abuse

  // ---- prediction 8, tree registry: the claimed note, the completed note and a refund note are notes ----
  await payout('P8a: the claimed note (R0) paid out', X.treeRegistry, tagOut, r0!.outSecrets, receipt.value, fresh('p8a'))
  await payout('P8b: the completed note (R1) paid out', X.treeRegistry, tagOut, r1!.outSecrets, r1Out.value, fresh('p8b'))
  await payout('P8c: the refund note (F3) paid out', X.treeRegistry, X.ETH_TAG, slip!.refundSecrets, X.DENOMINATION, fresh('p8c'))

  // ---- the append registry: the first batch, R2, the round ----
  const batchOf = async (name: string, start: number) => {
    const all = await X.settled('the append registry\'s leaves', async () => {
      const ls = await X.leavesOf(chain, X.appendRegistry)
      return ls.length === Number(await X.read(chain, X.appendRegistry, 'leafCount')) ? ls : undefined
    })
    const bw = await X.batchWords(all, start)
    proving[name] = bw.ms
    return step(name, X.batchTx({ chainId, r: X.appendRegistry, words: bw.words }), 'mined', { start, newRoot: `0x${bw.newRoot.toString(16)}` })
  }
  await batchOf('B0: the first batch of eight', 0)

  const r2 = await exportSpend('R2: R1 on the appending registry', X.appendRegistry, 'r2', X.How.COMPLETE, X.amm.address, await minOutFor(IN))
  const r2Out = r2!.events.completed[0]

  // R3: the round, proved by the committee.
  {
    const { leaves, tree, slot } = await treeFor(X.appendRegistry)
    const members = ['round0', 'round1', 'round2', 'round3'].map((l) => ({ secrets: secretsOf(l), index: indexOf(leaves, X.leafOf(X.ETH_TAG, X.innerOf(secretsOf(l)), X.DENOMINATION)) }))
    const ROUND_IN = 4n * X.DENOMINATION - X.FEE
    const st = X.roundStatement(members, tree, { destination: X.amm.address, fee: X.FEE, tagOut, minOut: await minOutFor(ROUND_IN) })
    const dir = join(secrets, 'round')
    const { proof, record } = await committeeProve({ cocircom, cosnarks, nodeModules: join(root, 'node_modules'), dir, pub: st.pub, owners: st.owners, publics: st.publics })
    out.committee = record
    const done = await step('R3: a round of four owners, one proof by a committee of three', X.roundTx({ chainId, r: X.appendRegistry, slot, root: st.root, words: [...st.head, ...proof] }), 'mined')
    const ev = await eventsIn(X.appendRegistry, done!.hash, done!.blockHash)
    out.round = { completed: ev.completed.map((c) => ({ value: c.value.toString(), leaf: `0x${c.leaf.toString(16)}` })) }
    if (ev.completed.length !== 4) throw new Error('R3: expected four completions')

    // Prediction 7: a round with a note already spent (R2's) is refused at the node.
    const spentRound = X.roundStatement([{ secrets: secretsOf('r2'), index: indexOf(leaves, X.leafOf(X.ETH_TAG, X.innerOf(secretsOf('r2')), X.DENOMINATION)) }, ...members.slice(0, 3)], tree, { destination: X.amm.address, fee: X.FEE, tagOut, minOut: 1n })
    const sp = await X.prove('round4', spentRound.witness, spentRound.publics)
    await step('F7: a round with a note already spent', X.roundTx({ chainId, r: X.appendRegistry, slot, root: spentRound.root, words: [...spentRound.head, ...sp.proof] }), 'refused')

    // Fill to sixteen leaves, then a batch over leaves the registry never took in, refused.
    await setupTx('three more deposits into the append registry', ['fill3', 'fill4', 'fill5'].map((l) => X.depositFrame(X.appendRegistry, X.innerOf(note(secretsOf(l))), X.DENOMINATION)))
    const all = await X.settled('sixteen leaves', async () => {
      const ls = await X.leavesOf(chain, X.appendRegistry)
      return ls.length === 16 ? ls : undefined
    })
    const forged = [...all.slice(0, 8), all[9], all[8], ...all.slice(10)]
    const bad = await X.batchWords(forged, 8)
    await step('F5: a batch whose leaves are not the accumulator\'s', X.batchTx({ chainId, r: X.appendRegistry, words: bad.words }), 'refused')
    const b1 = await batchOf('B1: the second batch, with R2\'s and the round\'s notes', 8)
    out.latency = { r2ToSpendableBlocks: Number(b1!.block - r2!.block), r3ToSpendableBlocks: Number(b1!.block - done!.block) }

    // Prediction 8, append registry: R2's note and one round note are notes.
    await payout('P8d: the completed note (R2) paid out', X.appendRegistry, tagOut, r2!.outSecrets, r2Out.value, fresh('p8d'))
    const m0 = st.order[0]
    await payout('P8e: a round\'s note paid out', X.appendRegistry, tagOut, X.roundOutSecrets(m0.secrets), BigInt(ev.completed[0].value), fresh('p8e'))
  }
  out.proving = proving
} finally {
  for (const n of nodes) await stopNode(n.child)
  rmSync(secrets, { recursive: true, force: true })
}

const record = {
  experiment: 'exp-e2e-frames experiment 15 (X10)',
  run: runLabel,
  deployment: X.DEPLOYMENT,
  date: new Date().toISOString(),
  repoCommit,
  pins,
  chainId: Number(chainId),
  contracts: Object.fromEntries(contracts.map((c) => [c.label, c.address])),
  hasher: X.HASHER,
  liquidity: { ether: LIQUIDITY_ETH.toString(), token: LIQUIDITY_TOKEN.toString() },
  setup,
  steps: rows,
  ...out,
}
const text = JSON.stringify(record, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 1)
for (const s of secretStrings) if (s.length > 8 && text.toLowerCase().includes(s.toLowerCase().replace(/^0x/, ''))) throw new Error('the record carries a secret; not writing it')
const file = join(here, 'results', `${runLabel}.json`)
writeFileSync(file, `${text}\n`)
console.log(`wrote ${file}`)
process.exit(0)
