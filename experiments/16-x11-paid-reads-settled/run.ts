// Experiment 16 (X11): a read server paid for blind tickets, on the test network. Set-up (the
// pool, the bonds, the purchase, a float) goes to the chain directly; every settlement, refund and
// slash goes to skandha node A, which gossips it to node B, which alone hands it to the chain.
// Every step is simulated first, and sent only if the simulation says what the step expects. The
// record is written to results/<n>-<label>.json after a search for every secret.
//
// usage: X11_DEPLOYMENT=<tag> npx tsx experiments/16-x11-paid-reads-settled/run.ts <n>-<label>
import { x25519 } from '@noble/curves/ed25519'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Address, type Hex, encodeFunctionData, hexToBytes, keccak256, toHex } from 'viem'
import { type Node, type Pin, buildSkandha, checkout, linesNaming, loadKey, peersOf, rpcUrlOf, run, startNode, stopNode, until, writeConfig } from '../../src/e2e/index.js'
import { sendFrames } from '../../src/exp-frames/deploy.js'
import { type FrameTx, type FrameTxJson, frameReceiptGas, frameReceiptStatus, frameTxFromJson, frameTxHash, getFrameTxJson, makeClient, sendFrameTx, senderFrame, serializeFrameTx, simulateFrameTx, waitForFrameTxReceipt } from '../../src/exp-frames/frametx/index.js'
import { Attester, Server, answerOf, decrypt, isSig } from './parties.js'
import { blind, dealIssuers, factorOf, issuerAnswer, keyHex, serialOf, unblind } from './tickets.js'
import * as X from './x11.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const work = join(root, 'work')
const runLabel = process.argv[2]
if (!runLabel || !/^\d+-[a-z0-9-]+$/.test(runLabel)) throw new Error('usage: run.ts <n>-<label>')
// The record is written at the end; its directory is made now (experiment 15's pass d4 lost one).
mkdirSync(join(here, 'results'), { recursive: true })
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8')) as Record<string, Pin>
const { privateKey, address: funder } = loadKey()
const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
const dirty = (await run('git', ['status', '--porcelain', '--', 'experiments/16-x11-paid-reads-settled', 'src'], { cwd: root })).trim()
if (dirty) throw new Error(`commit the experiment before a recorded run:\n${dirty}`)

const chain = makeClient()
const chainId = BigInt(await chain.getChainId())
const pool = X.poolOf(privateKey)
const head = () => X.settled('the head', async () => await chain.getBlockNumber())

// Every secret of the run, searched for in the record before it is written.
const secretStrings: string[] = [privateKey]
const keep = (k: Hex) => { secretStrings.push(k); return k }
const issuers = dealIssuers(keep(X.keyOf(privateKey, 'issuers')))
for (const s of issuers.shares) secretStrings.push(s.toString(16), s.toString())
const readerSeed = keep(X.keyOf(privateKey, 'reader'))
for (let i = 0; i < X.MEMBERS; i++) keep(X.keyOf(privateKey, `member/${i}`))

type Row = Record<string, unknown>
const rows: Row[] = []
const setup: Row[] = []
const out: Record<string, unknown> = {}

// ---- set-up, to the chain directly ----

async function setupTx(what: string, frames: Parameters<typeof sendFrames>[2]) {
  for (let attempt = 1; ; attempt++) {
    const nonce = await chain.getTransactionCount({ address: funder, blockTag: 'latest' })
    try {
      const r = await sendFrames(chain, privateKey, frames, { label: what })
      if (!r?.hash || !r.receipt) throw new Error(`${what}: not mined`)
      const ok = r.receipt.frameReceipts.every((f) => frameReceiptStatus(f) === 1)
      setup.push({ what, hash: r.hash, block: Number(BigInt(r.receipt.blockNumber)), gasUsed: Number(BigInt(r.receipt.gasUsed)), ok, attempt })
      if (!ok) throw new Error(`${what}: a frame failed`)
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
const call = (data: Hex, value = 0n) => senderFrame({ target: pool.address, data, value, execution: 100_000n, state: 2n * 97_920n })
const read = <T>(fn: 'sold' | 'paid' | 'refunded' | 'price' | 'slashAmount', ...args: never[]) =>
  X.settled(`${fn}()`, async () => (await chain.readContract({ address: pool.address, abi: X.poolAbi, functionName: fn, args } as never)) as T)
const bondOf = (i: number) => X.settled(`bondOf(${i})`, async () => (await chain.readContract({ address: pool.address, abi: X.poolAbi, functionName: 'bondOf', args: [BigInt(i)] })) as bigint)
const balance = (a: Address) => X.settled(`balance of ${a}`, async () => await chain.getBalance({ address: a }))

console.log(`deployment ${X.DEPLOYMENT}: pool ${pool.address}`)
{
  const code = await chain.getCode({ address: pool.address })
  if (code && code !== '0x') throw new Error('the pool is already deployed: set X11_DEPLOYMENT to a fresh tag')
}
await setupTx('deploy the pool', [pool.deploy])
for (let i = 0; i < X.MEMBERS; i++) {
  const m = await X.settled(`member(${i})`, async () => (await chain.readContract({ address: pool.address, abi: X.poolAbi, functionName: 'member', args: [BigInt(i)] })) as Address)
  if (m !== pool.members[i]) throw new Error(`member ${i} is ${m}, not ${pool.members[i]}`)
}

// The tickets: one server with a read of one, one of 16, one of 256, and one with two reads, the
// second of which it will withhold from the attesters.
const SERVERS = { s1: 1, s16: 16, s256: 256, sd: 2 } as const
type ServerName = keyof typeof SERVERS
const N = Object.values(SERVERS).reduce((a, b) => a + b, 0)
const FLOAT = 10n ** 16n
await setupTx('four bonds, the tickets bought, and a float', [
  ...[0, 1, 2, 3].map((i) => call(encodeFunctionData({ abi: X.poolAbi, functionName: 'bond', args: [BigInt(i)] }), X.BOND)),
  call(encodeFunctionData({ abi: X.poolAbi, functionName: 'buy', args: [BigInt(N)] }), BigInt(N) * X.PRICE),
  senderFrame({ target: pool.address, value: FLOAT, execution: 50_000n, state: 0n }),
])
if ((await read<bigint>('sold')) !== BigInt(N)) throw new Error('the pool did not count the purchase')
for (let i = 0; i < X.MEMBERS; i++) if ((await bondOf(i)) !== X.BOND) throw new Error(`member ${i}'s bond`)
const poolStart = await balance(pool.address)

// ---- issuance, off chain: blind, three issuers of four, unblind ----

const key = keyHex(issuers)
const servers = Object.fromEntries(
  (Object.keys(SERVERS) as ServerName[]).map((s) => [s, new Server(X.addressOf(privateKey, `server/${s}`), key, hexToBytes(keep(X.keyOf(privateKey, `server/${s}/x25519`))))]),
) as Record<ServerName, Server>
type Ticket = { server: ServerName; label: string; serial: Hex; ticket: Hex; blinded: Hex; quorum: number[] }
const tickets: Ticket[] = []
const t0 = performance.now()
for (const s of Object.keys(SERVERS) as ServerName[]) {
  for (let k = 0; k < SERVERS[s]; k++) {
    const label = `${s}-${k}`
    const serial = serialOf(readerSeed, label)
    const factor = factorOf(readerSeed, label)
    secretStrings.push(factor.toString(16), factor.toString())
    const { blinded } = blind(servers[s].address, serial, factor)
    // Every quorum of three takes its turn.
    const quorum = [0, 1, 2, 3].filter((i) => i !== tickets.length % 4)
    const ticket = unblind(quorum.map((i) => ({ issuer: i, answer: issuerAnswer(issuers, i, blinded) })), factor)
    tickets.push({ server: s, label, serial, ticket, blinded, quorum })
  }
}
out.issuance = { tickets: tickets.length, millis: Math.round(performance.now() - t0), key, note: 'the issuers\' key is dealt by one process here; experiment 04 and exp-frames 36 used Commonware\'s DKG' }
const ticketOf = (label: string) => tickets.find((t) => t.label === label)!

// ---- the attesters: four, the fourth signing whatever it is asked ----

const DISHONEST = 3
const members = [0, 1, 2, 3].map((i) => new Attester(i, X.keyOf(privateKey, `member/${i}`), i !== DISHONEST, key, chainId, pool.address))

// ---- the nodes ----

const skandha = await checkout('skandha', pins.skandha, work)
await buildSkandha(skandha)
const stamp = Date.now()
const config = join(work, `x11-${stamp}.json`)
writeConfig(config)
const nodes: Node[] = []
let nodeA: ReturnType<typeof makeClient> | undefined

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

  // A node's lines naming a transaction, without the head lines' pending lists.
  const KEEP = ['t', 'event', 'result', 'client', 'outcome', 'agrees', 'peers']
  const logsOf = (log: string, hash: string) =>
    linesNaming(log, hash)
      .filter((l) => l.event !== 'head')
      .map((l) => Object.fromEntries(KEEP.filter((k) => l[k] !== undefined).map((k) => [k, l[k]])))

  /** Simulate; if it says what `expect` says, send to node A; for a mined step, wait for it. */
  async function step(name: string, tx: FrameTx, expect: 'mined' | 'refused', extra: Row = {}) {
    let sim = await simulateFrameTx(chain, tx)
    for (let i = 0; expect === 'mined' && (!sim.valid || sim.executionStatus !== 'success') && i < 10; i++) {
      await new Promise((res) => setTimeout(res, 6_000))
      sim = await simulateFrameTx(chain, tx)
    }
    const simRow = { valid: sim.valid, violation: sim.violation, executionStatus: sim.executionStatus, gasUsed: sim.gasUsed ? Number(BigInt(sim.gasUsed)) : null, frames: sim.frames?.map((f) => ({ gasUsed: Number(BigInt(f.gasUsed)), succeeded: f.succeeded })) }
    const hash = frameTxHash(tx)
    const calldataBytes = (tx.frames[1].data.length - 2) / 2
    if (expect === 'refused') {
      if (sim.valid) throw new Error(`${name}: expected a refusal, but simulation admits it (${JSON.stringify(simRow)})`)
      let node = 'admitted'
      try {
        await sendFrameTx(nodeA!, tx)
      } catch (e) {
        node = (e as Error).message.split('\n')[0].slice(0, 200)
      }
      if (node === 'admitted') throw new Error(`${name}: node A admitted what simulation refused`)
      const logged = await until(`node A's line for ${hash}`, async () => {
        const ls = logsOf(a.log, hash)
        return ls.length > 0 ? ls : undefined
      }, 10_000).catch(() => [])
      console.log(`${name}: refused (${sim.violation}); node A: ${node}; logged ${JSON.stringify(logged)}`)
      rows.push({ step: name, expect, outcome: 'refused', hash, calldataBytes, simulation: simRow, nodeA: node, nodeALog: logged, ...extra })
      return undefined
    }
    if (!sim.valid || sim.executionStatus !== 'success') throw new Error(`${name}: simulation does not admit it: ${JSON.stringify(simRow)}`)
    await sendFrameTx(nodeA!, tx)
    const r = await waitForFrameTxReceipt(chain, hash, { timeoutMs: 180_000 })
    const frames = r.frameReceipts.map((f) => ({ status: frameReceiptStatus(f), ...frameReceiptGas(f) }))
    const ok = frames.every((f) => f.status === 1)
    const row = { step: name, expect, outcome: ok ? 'mined' : 'mined, a frame failed', hash, block: Number(BigInt(r.blockNumber)), gasUsed: Number(BigInt(r.gasUsed)), calldataBytes, frames: frames.map((f) => ({ status: f.status, execution: Number(f.execution), state: Number(f.state) })), simulation: simRow, nodeA: logsOf(a.log, hash), nodeB: logsOf(b.log, hash), ...extra }
    console.log(`${name}: ${hash} block ${row.block} gasUsed ${row.gasUsed} frames ${frames.map((f) => `${f.status}:${f.execution}+${f.state}s`).join(' / ')}`)
    rows.push(row)
    if (!ok) throw new Error(`${name}: a frame failed`)
    return { hash, block: BigInt(r.blockNumber) }
  }

  async function untilBlock(n: bigint) {
    await until(`block ${n}`, async () => ((await chain.getBlockNumber()) >= n ? true : undefined), 3_600_000, 3_000)
  }

  // ---- the reads, all in one epoch ----

  // Start near an epoch's beginning, so that every delivery lands in the same epoch.
  {
    const h = await head()
    if (h % X.EPOCH > 3n) await untilBlock((X.epochOf(h) + 1n) * X.EPOCH)
  }
  const readEpoch = X.epochOf(await head())
  const readerSecret = hexToBytes(keep(X.keyOf(privateKey, 'reader/x25519')))
  const readerKey = toHex(x25519.getPublicKey(readerSecret))
  const queries = new Map<Hex, Hex>()
  const replies = new Map<Hex, { ciphertext: Hex; serverKey: Hex }>()
  const deliveries: Row[] = []
  // Each server's reads are delivered as a group: the head is read before and after it, and both
  // must be in the read epoch, so every delivery in between was too.
  for (const s of Object.keys(SERVERS) as ServerName[]) {
    const server = servers[s]
    const h = await head()
    for (const t of tickets.filter((x) => x.server === s)) {
      const query = keccak256(toHex(`exp-e2e-frames/16/${X.DEPLOYMENT}/query/${t.label}`))
      queries.set(t.serial, query)
      const res = server.handle({ query, serial: t.serial, ticket: t.ticket, readerKey })
      if (!('ciphertext' in res)) throw new Error(`${t.label}: the server refused a good ticket: ${JSON.stringify(res)}`)
      replies.set(t.serial, res)
      // The server withholds sd-1 from the attesters; it delivers the rest to all four.
      if (t.label === 'sd-1') continue
      for (const m of members) {
        const v = m.deliver({ server: server.address, serial: t.serial, ticket: t.ticket, ciphertext: res.ciphertext }, h)
        if (!v.ok) throw new Error(`${t.label}: member ${m.index} refused a delivery: ${v.reason}`)
      }
      deliveries.push({ label: t.label, head: Number(h) })
    }
    const after = await head()
    if (X.epochOf(h) !== readEpoch || X.epochOf(after) !== readEpoch) throw new Error(`${s}'s reads ran from block ${h} to ${after}, outside epoch ${readEpoch}: rerun`)
  }
  out.reads = {
    epoch: Number(readEpoch),
    reads: tickets.length,
    delivered: deliveries.length,
    withheldFromAttesters: ['sd-1'],
    withheldFromReader: ['s1-0'],
    firstHead: deliveries[0].head,
    lastHead: deliveries.at(-1)!.head,
    memberCheckMillis: members.map((m) => ({ member: m.index, mean: +(m.checkMillis.reduce((x, y) => x + y, 0) / m.checkMillis.length).toFixed(2), max: +Math.max(...m.checkMillis).toFixed(2) })),
  }

  // Prediction 5: the server withholds s1-0's answer from the reader; one member has it.
  {
    const t = ticketOf('s1-0')
    const ct = members[1].fetch(t.serial)
    const got = ct ? decrypt(readerSecret, replies.get(t.serial)!.serverKey, t.serial, ct) : undefined
    out.withheldAnswer = { from: 'member 1', fetched: !!ct, decryptsToTheAnswer: got === answerOf(queries.get(t.serial)!) }
    if (!out.withheldAnswer || got !== answerOf(queries.get(t.serial)!)) throw new Error('prediction 5: the reader could not get its answer from a member')
  }

  // ---- after the epoch: the batches and their signatures ----

  await untilBlock(X.epochEnd(readEpoch) + 1n)
  const batchOf = (s: ServerName, labels?: string[]): X.Batch => ({
    server: servers[s].address,
    epoch: readEpoch,
    serials: (labels ?? tickets.filter((t) => t.server === s).map((t) => t.label)).map((l) => ticketOf(l).serial),
  })
  const b1 = batchOf('s1')
  const b16 = batchOf('s16')
  const b256 = batchOf('s256')
  const bdBoth = batchOf('sd', ['sd-0', 'sd-1'])
  const bd = batchOf('sd', ['sd-0'])
  const verdicts: Row[] = []
  async function signAll(what: string, b: X.Batch) {
    const h = await head()
    const res = await Promise.all(members.map((m) => m.signBatch(b, h)))
    verdicts.push({ what, signed: res.map((r, i) => (isSig(r) ? i : -1)).filter((i) => i >= 0), refusals: res.map((r, i) => (isSig(r) ? undefined : { member: i, reason: r.ok ? '' : r.reason })).filter(Boolean) })
    return res
  }
  const sigs1 = await signAll('the batch of 1', b1)
  const sigs16 = await signAll('the batch of 16', b16)
  const sigs256 = await signAll('the batch of 256', b256)
  await signAll('sd\'s batch with the withheld read', bdBoth)
  const sigsD = await signAll('sd\'s batch without it', bd)
  const three = (res: Awaited<ReturnType<typeof signAll>>) => {
    const ok = res.filter(isSig)
    if (ok.length < 3) throw new Error('fewer than three signatures for a batch every honest member saw')
    return ok.slice(0, 3)
  }

  // Predictions 1 and 2: three batch sizes, the same settlement.
  await step('settle the batch of 1', X.settleTx(chainId, pool, X.settleWords(b1, three(sigs1))), 'mined', { n: 1 })
  await step('settle the batch of 16', X.settleTx(chainId, pool, X.settleWords(b16, three(sigs16))), 'mined', { n: 16 })
  await step('settle the batch of 256', X.settleTx(chainId, pool, X.settleWords(b256, three(sigs256))), 'mined', { n: 256 })

  // Prediction 3: only a quorum pays, once.
  await step('settle the batch of 16 again', X.settleTx(chainId, pool, X.settleWords(b16, three(sigs16))), 'refused')
  await step('settle, under sd, with the batch of 1\'s signatures', X.settleTx(chainId, pool, X.settleWords({ ...b1, server: servers.sd.address }, three(sigs1))), 'refused')
  {
    const s = three(sigsD)
    const wrong = { ...(sigs1.filter(isSig).find((x) => x.member === s[2].member) as X.Sig) }
    await step('settle sd\'s batch with two of its signatures', X.settleTx(chainId, pool, X.settleWords(bd, [s[0], s[1], wrong])), 'refused')
  }

  // Prediction 4, the server's half: the batch with the withheld read never had a quorum; the one
  // without it settles.
  await step('settle sd\'s batch without the withheld read', X.settleTx(chainId, pool, X.settleWords(bd, three(sigsD))), 'mined', { n: 1 })

  // ---- the refunds, asked of every member at once, signed an epoch later ----

  const refundTo = X.addressOf(privateKey, 'reader/refund')
  const settledSerial = ticketOf('s16-0')
  const badRefundTo = X.addressOf(privateKey, 'reader/refund-of-a-settled-serial')
  // Every member hears a refund at the same head: each starts its wait when it first hears.
  const askRefund = (t: Ticket, to: Address, h: bigint) =>
    Promise.all(members.map((m) => m.signRefund({ server: servers[t.server].address, serial: t.serial, ticket: t.ticket, recipient: to }, h)))
  const asked = await head()
  const firstAsk = await askRefund(ticketOf('sd-1'), refundTo, asked)
  await askRefund(settledSerial, badRefundTo, asked)
  verdicts.push({ what: 'the withheld read\'s refund, asked', signed: firstAsk.map((r, i) => (isSig(r) ? i : -1)).filter((i) => i >= 0) })
  await untilBlock(X.epochEnd(X.epochOf(asked)) + 1n)
  const later = await head()
  const refundSigs = await askRefund(ticketOf('sd-1'), refundTo, later)
  const badRefundSigs = await askRefund(settledSerial, badRefundTo, later)
  verdicts.push({ what: 'the withheld read\'s refund, an epoch later', signed: refundSigs.map((r, i) => (isSig(r) ? i : -1)).filter((i) => i >= 0) })
  verdicts.push({ what: 'a refund of a settled serial', signed: badRefundSigs.map((r, i) => (isSig(r) ? i : -1)).filter((i) => i >= 0), refusals: badRefundSigs.map((r, i) => (isSig(r) ? undefined : { member: i, reason: r.ok ? '' : r.reason })).filter(Boolean) })
  const before = await balance(refundTo)
  await step('the withheld read refunded', X.refundTx(chainId, pool, X.refundWords(ticketOf('sd-1').serial, refundTo, refundSigs.filter(isSig).slice(0, 3))), 'mined')
  out.refund = { recipient: refundTo, received: ((await X.settled('the refund', async () => { const v = await balance(refundTo); return v > before ? v : undefined })) - before).toString() }

  // ---- predictions 6 and 7: the dishonest member ----

  const m3 = (res: Awaited<ReturnType<typeof signAll>>) => res[DISHONEST] as X.Sig
  const reporter = X.addressOf(privateKey, 'reporter')
  // A batch repeating s1-0, already settled: only the dishonest member signs it.
  // The same serial under the epoch before: a different digest, so the two signatures conflict.
  const repeat: X.Batch = { server: servers.s1.address, epoch: readEpoch - 1n, serials: [ticketOf('s1-0').serial] }
  const repeatSigs = await signAll('a batch repeating a settled serial', repeat)
  {
    const honest = sigs1.filter(isSig).filter((s) => s.member !== DISHONEST).slice(0, 2)
    await step('settle the repeat with the dishonest signature and two over another batch', X.settleTx(chainId, pool, X.settleWords(repeat, [...honest, m3(repeatSigs)])), 'refused')
  }
  {
    const honest = sigs16.filter(isSig).filter((s) => s.member !== DISHONEST).slice(0, 2)
    await step('refund a settled serial with the dishonest signature and two over its batch', X.refundTx(chainId, pool, X.refundWords(settledSerial.serial, badRefundTo, [...honest, badRefundSigs[DISHONEST] as X.Sig])), 'refused')
  }
  // Before any slash, while the bond is whole: a pair with no serial in common is not a conflict.
  const noConflict = X.slashTwoBatches({ member: DISHONEST, reporter, a: b1, sigA: m3(sigs1), b: b16, sigB: m3(sigs16), serial: ticketOf('s1-0').serial })
  await step('slash: two batches with no serial in common', X.slashTx(chainId, pool, noConflict), 'refused')
  const reported = await balance(reporter)
  const kind1 = X.slashTwoBatches({ member: DISHONEST, reporter, a: b1, sigA: m3(sigs1), b: repeat, sigB: m3(repeatSigs), serial: ticketOf('s1-0').serial })
  await step('slash: one serial in two batches', X.slashTx(chainId, pool, kind1), 'mined', { kind: 1 })
  await step('slash: the same pair again', X.slashTx(chainId, pool, kind1), 'refused')
  const kind2 = X.slashBatchAndRefund({ member: DISHONEST, reporter, a: b16, sigA: m3(sigs16), serial: settledSerial.serial, recipient: badRefundTo, sigR: badRefundSigs[DISHONEST] as X.Sig })
  await step('slash: one serial in a batch and a refund', X.slashTx(chainId, pool, kind2), 'mined', { kind: 2 })
  out.slashes = { reporter, received: ((await balance(reporter)) - reported).toString(), bonds: await Promise.all([0, 1, 2, 3].map(async (i) => (await bondOf(i)).toString())) }

  // ---- prediction 8: what L1 carries ----

  const mined = rows.filter((r) => r.outcome === 'mined')
  const raw = await Promise.all(mined.map(async (r) => serializeFrameTx(frameTxFromJson((await X.settled(`${r.step}: the transaction`, async () => (await getFrameTxJson(chain, r.hash as Hex)) ?? undefined)) as FrameTxJson))))
  const needles = [...queries.values(), ...[...queries.values()].map(answerOf), readerKey, ...[...replies.values()].map((x) => x.ciphertext), funder]
  out.onChain = {
    transactions: mined.length,
    searchedFor: 'every query, every answer, every ciphertext, the reader\'s X25519 key and the buyer\'s address',
    found: needles.filter((n) => raw.some((t) => t.toLowerCase().includes(n.slice(2).toLowerCase()))).length,
  }
  out.verdicts = verdicts
  out.pool = {
    sold: (await read<bigint>('sold')).toString(),
    paid: (await read<bigint>('paid')).toString(),
    refunded: (await read<bigint>('refunded')).toString(),
    balanceAfterSetup: poolStart.toString(),
    balanceAtEnd: (await balance(pool.address)).toString(),
  }
  out.servers = Object.fromEntries((Object.keys(SERVERS) as ServerName[]).map((s) => [s, servers[s].address]))
} finally {
  for (const n of nodes) await stopNode(n.child)
}

const record = {
  experiment: 'exp-e2e-frames experiment 16 (X11)',
  run: runLabel,
  deployment: X.DEPLOYMENT,
  date: new Date().toISOString(),
  repoCommit,
  pins,
  chainId: Number(chainId),
  client: await chain.request({ method: 'web3_clientVersion' } as never),
  pool: pool.address,
  members: pool.members,
  price: X.PRICE.toString(),
  slashAmount: X.SLASH.toString(),
  bond: X.BOND.toString(),
  epochBlocks: Number(X.EPOCH),
  tickets: tickets.map((t) => ({ label: t.label, server: t.server, serial: t.serial, ticket: t.ticket, blinded: t.blinded, quorum: t.quorum })),
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
