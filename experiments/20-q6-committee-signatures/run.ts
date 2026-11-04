// Experiment 20 (Q6), arms 1, 3 and 4 for X5 and X11, on one chain: X5's result board (3 of 4)
// and X11's read pool (3 of 4), each signed by named leanSPHINCS members, with the refusals and,
// for every mined committee transaction, the members an observer reads from it.
// usage: npx tsx experiments/20-q6-committee-signatures/run.ts <label> <local|testnet>
import { type Address, type Hex, keccak256, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { senderFrame } from '../../src/exp-frames/frametx/index.js'
import { type Row, openChain } from './chain.js'
import * as Q from './q6.js'

const [label, where] = process.argv.slice(2)
if (!label || !['local', 'testnet'].includes(where)) throw new Error('usage: run.ts <label> <local|testnet>')
const c = await openChain(where as 'local' | 'testnet', label)
const { chainId, placement, privateKey } = c
const rnd = (l: string): Hex => keccak256(toHex(`exp-e2e-frames/20/${Q.DEPLOYMENT}/${label}/${l}/${crypto.randomUUID()}`))
const fresh = (l: string): Address => privateKeyToAddress(keccak256(toHex(`${privateKey}/q6/${Q.DEPLOYMENT}/${label}/fresh/${l}`)))
const out: Row = {}
const firstBlock = Number(await c.chain.getBlockNumber())

/** Signs m with each signer's key (on the message it names), hands the witnesses to the node, and returns the triples. */
function sign(signers: Q.Signer[], witness: boolean) {
  const signed = signers.map((s) => Q.L.sign(s.member.seed, Buffer.from(s.on.slice(2), 'hex')))
  if (signed.some((s) => !s.verified)) throw new Error('a member\'s own signature did not verify')
  const triples = Q.triplesOf(signers)
  if (witness) signers.forEach((s, i) => c.putWitness(Q.triple(s.on, s.member.key), signed[i]))
  return { triples, signed, signMs: signed.map((s) => s.signMs) }
}
const observed: Row[] = []
const offChain: Row[] = []
async function committeeStep(arm: string, step: string, build: (triples: Hex) => Parameters<typeof c.frameStep>[1], signers: Q.Signer[], keys: Hex[], skipBytes: number, refusal?: string) {
  const s = sign(signers, !refusal)
  const tx = build(s.triples)
  const row = await c.frameStep(step, tx, { arm, refusal: refusal ?? null, declared: c.declaredGas(signers.length), signatures: signers.length, signMs: s.signMs }, Boolean(refusal))
  if (row.outcome === 'mined' && !refusal) {
    const read = Q.signersRead(tx, keys, skipBytes)
    observed.push({ arm, step, hash: row.hash, frame: read.frame, signers: read.signers, distinctMessages: [...new Set(read.messages)].length })
    // On the test network nobody checks the signatures on chain: the prover aggregates and checks them here.
    if (placement === 'modelled') offChain.push({ arm, step, hash: row.hash, ...Q.aggregate(s.signed) })
  }
  return row
}

// ---- arm 1: X5's result board, 3 of 4 ----
{
  const x5 = Q.committeeOf(privateKey, 'x5', 4)
  for (const m of [...x5.members, x5.outsider]) c.secrets.push(Q.word(BigInt(`0x${Buffer.from(m.seed).toString('hex')}`)))
  const keys = x5.members.map((m) => m.key)
  const board = Q.boardOf(keys)
  await c.setupTx('X5: deploy the result board and its float', [board.deploy, senderFrame({ target: board.address, value: 10n ** 15n, execution: 30_000n, state: 0n })])
  out.x5 = { board: board.address, codeBytes: (board.initcode.length - 2) / 2 - 32 * (keys.length + 2), members: keys, quorum: 3 }
  const result = (signers: number[], l: string, other?: { member: number; on: Hex }[], outsider = false) => {
    const request = rnd(`x5/request/${l}`)
    const handle = rnd(`x5/handle/${l}`)
    const value = 42n
    const m = Q.resultMessage(chainId, request, handle, value)
    const ss: Q.Signer[] = signers.map((i) => ({ member: x5.members[i], on: m }))
    if (outsider) ss.push({ member: x5.outsider, on: m })
    for (const o of other ?? []) ss.push({ member: x5.members[o.member], on: o.on })
    return { ss, build: (t: Hex) => Q.resultTx(chainId, board.address, request, handle, value, t, placement) }
  }
  for (const [l, by] of [['members 0, 1, 2', [0, 1, 2]], ['members 1, 2, 3', [1, 2, 3]], ['all four members', [0, 1, 2, 3]]] as const) {
    const r = result([...by], l)
    await committeeStep('x5', `X5: a result signed by ${l}`, r.build, r.ss, keys, 96)
  }
  // Arm 4: the refusals.
  const two = result([0, 1], 'two')
  await committeeStep('x5', 'X5 refusal: two signatures of three', two.build, two.ss, keys, 96, 'below the quorum')
  const dup = result([0, 1, 1], 'dup')
  await committeeStep('x5', 'X5 refusal: member 1\'s signature declared twice', dup.build, dup.ss, keys, 96, 'one member counted twice')
  const outs = result([0, 1], 'outsider', [], true)
  await committeeStep('x5', 'X5 refusal: a key outside the committee as the third', outs.build, outs.ss, keys, 96, 'a key outside the committee')
  const another = result([0, 1], 'another', [{ member: 2, on: rnd('x5/another-message') }])
  await committeeStep('x5', 'X5 refusal: member 2\'s signature on another message', another.build, another.ss, keys, 96, 'a signature on another message')
  // Arm 6: member 3 replaced. Its key is in the board's code, so a new board is deployed with the
  // new key (and the old one stops being used); there is no key update to call.
  const replacement = Q.committeeOf(privateKey, 'x5-replacement', 1).members[0]
  c.secrets.push(Q.word(BigInt(`0x${Buffer.from(replacement.seed).toString('hex')}`)))
  const keys2 = [...keys.slice(0, 3), replacement.key]
  const board2 = Q.fixedBoard(keys2, 'board/replaced-3')
  const d = await c.setupTx('X5, arm 6: a new board with member 3 replaced', [board2.deploy])
  out.replacement = { arm: 'x5', what: 'member 3 replaced: a new board deployed with the new key', board: board2.address, deployGas: d.gasUsed, initcodeBytes: (board2.initcode.length - 2) / 2 }
  const r2 = (() => {
    const request = rnd('x5/request/after-replacement')
    const handle = rnd('x5/handle/after-replacement')
    const m = Q.resultMessage(chainId, request, handle, 42n)
    return { ss: [0, 2].map((i) => ({ member: x5.members[i], on: m })).concat([{ member: replacement, on: m }]), build: (t: Hex) => Q.resultTx(chainId, board2.address, request, handle, 42n, t, placement) }
  })()
  await c.setupTx('X5, arm 6: the new board\'s float', [senderFrame({ target: board2.address, value: 10n ** 15n, execution: 30_000n, state: 0n })])
  await committeeStep('x5', 'X5, arm 6: a result on the new board signed by members 0, 2 and the new member 3', r2.build, r2.ss, keys2, 96)
}

// ---- arm 3: X11's read pool, 3 of 4 ----
{
  const x11 = Q.committeeOf(privateKey, 'x11', 4)
  for (const m of [...x11.members, x11.outsider]) c.secrets.push(Q.word(BigInt(`0x${Buffer.from(m.seed).toString('hex')}`)))
  const keys = x11.members.map((m) => m.key)
  const pool = Q.poolOf(keys)
  const X = Q.X11
  const poolAbi = X.poolAbi
  const { encodeFunctionData } = await import('viem')
  await c.setupTx('X11: deploy the read pool and its float', [pool.deploy, senderFrame({ target: pool.address, value: 10n ** 15n, execution: 30_000n, state: 0n })])
  // Two members bonded (the two the run slashes), and eight tickets sold.
  await c.setupTx('X11: members 1 and 2 bond', [1n, 2n].map((i) => senderFrame({ target: pool.address, value: X.BOND, data: encodeFunctionData({ abi: poolAbi, functionName: 'bond', args: [i] }), execution: 60_000n, state: 97_920n })))
  await c.setupTx('X11: eight tickets bought', [senderFrame({ target: pool.address, value: 8n * X.PRICE, data: encodeFunctionData({ abi: poolAbi, functionName: 'buy', args: [8n] }), execution: 60_000n, state: 2n * 97_920n })])
  out.x11 = { pool: pool.address, members: keys, quorum: 3, price: X.PRICE, slash: X.SLASH, bond: X.BOND }
  const serials = Array.from({ length: 6 }, (_, i) => rnd(`x11/serial/${i}`))
  const head = BigInt(await c.chain.getBlockNumber())
  const batchA: Q.X11.Batch = { server: fresh('server/a'), epoch: X.epochOf(head), serials: serials.slice(0, 4) }
  const batchB: Q.X11.Batch = { server: fresh('server/b'), epoch: X.epochOf(head), serials: [serials[0], serials[4]] }
  const by = (idx: number[], m: Hex): Q.Signer[] => idx.map((i) => ({ member: x11.members[i], on: m }))
  const settle = (b: Q.X11.Batch) => (t: Hex) => Q.poolTx(chainId, pool.address, X.keyFor(1n, BigInt(b.server), b.epoch), 'settle', Q.settleWords(b), t, placement)
  const dA = X.batchDigest(chainId, pool.address, batchA)
  const dB = X.batchDigest(chainId, pool.address, batchB)

  // Refusals first, while the batch is unsettled, so each is refused for its signatures alone.
  await committeeStep('x11', 'X11 refusal: a settlement with two signatures of three', settle(batchA), by([0, 1], dA), keys, 0, 'below the quorum')
  await committeeStep('x11', 'X11 refusal: a settlement with member 1\'s signature declared twice', settle(batchA), by([0, 1, 1], dA), keys, 0, 'one member counted twice')
  await committeeStep('x11', 'X11 refusal: a settlement with a key outside the committee as the third', settle(batchA), [...by([0, 1], dA), { member: x11.outsider, on: dA }], keys, 0, 'a key outside the committee')
  await committeeStep('x11', 'X11 refusal: a settlement with member 2\'s signature on another batch', settle(batchA), [...by([0, 1], dA), { member: x11.members[2], on: dB }], keys, 0, 'a signature on another message')

  await committeeStep('x11', 'X11: batch A (4 tickets) settled by members 0, 1, 2', settle(batchA), by([0, 1, 2], dA), keys, 0)
  const serial = serials[5]
  const recipient = fresh('reader')
  const dR = X.refundDigest(chainId, pool.address, serial, recipient)
  await committeeStep('x11', 'X11: a refund signed by members 1, 2, 3', (t) => Q.poolTx(chainId, pool.address, X.keyFor(2n, BigInt(serial), 0n), 'refund', Q.refundWords(serial, recipient), t, placement), by([1, 2, 3], dR), keys, 0)

  // Slashing: a member's two conflicting signatures, declared as two dependencies under its key.
  const reporter = fresh('reporter')
  const w1 = Q.slashTwoBatches(1, reporter, batchA, batchB, serials[0])
  const slash1 = (t: Hex) => Q.poolTx(chainId, pool.address, Q.slashKeyOf(1, dA, dB, 1), 'slash', w1, t, placement)
  await committeeStep('x11', 'X11 refusal: slashing member 1 with its signature and member 2\'s', slash1, [{ member: x11.members[1], on: dA }, { member: x11.members[2], on: dB }], keys, 0, 'a second signature not the member\'s')
  await committeeStep('x11', 'X11: member 1 slashed for one serial in two batches (kind 1)', slash1, [{ member: x11.members[1], on: dA }, { member: x11.members[1], on: dB }], keys, 0)
  const dR2 = X.refundDigest(chainId, pool.address, serials[1], recipient)
  const w2 = Q.slashBatchAndRefund(2, reporter, batchA, serials[1], recipient)
  await committeeStep('x11', 'X11: member 2 slashed for one serial in a batch and a refund (kind 2)', (t) => Q.poolTx(chainId, pool.address, Q.slashKeyOf(2, dA, dR2, 2), 'slash', w2, t, placement), [{ member: x11.members[2], on: dA }, { member: x11.members[2], on: dR2 }], keys, 0)
  const read = async (fn: 'paid' | 'refunded' | 'sold') => c.chain.readContract({ address: pool.address, abi: poolAbi, functionName: fn })
  out.x11State = { sold: await read('sold'), paid: await read('paid'), refunded: await read('refunded'), bond1: await c.chain.readContract({ address: pool.address, abi: poolAbi, functionName: 'bondOf', args: [1n] }), bond2: await c.chain.readContract({ address: pool.address, abi: poolAbi, functionName: 'bondOf', args: [2n] }) }
}

const lastBlock = Number(await c.chain.getBlockNumber())
c.stop()
c.write(`${label}.json`, {
  experiment: 20, run: label, chain: where, placement, deployment: Q.DEPLOYMENT, repoCommit: c.repoCommit, chainId: Number(chainId), funder: c.funder, ethrex: c.ethrex ?? null,
  blocks: { first: firstBlock, last: lastBlock }, setup: c.setup, rows: c.rows, observed, offChain, ...out,
  nodeRecords: where === 'local' ? { builds: c.jsonl('builds.jsonl'), checks: c.jsonl('checks.jsonl') } : null,
  transactions: c.txs,
})
process.exit(0)
