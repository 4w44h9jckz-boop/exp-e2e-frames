// X9: an exit that nobody's permission opens, for a committee that holds state. The README's plan,
// steps 1 to 7, on the test network through two skandha nodes. Every transaction goes to node A,
// except the deployment and the deposits, which go to the chain directly.
// - The committee:
//   - committee/exit-committee: its keys, intents, parts, openings and reconciliation;
//   - committee/co-withdraw `member --recipient`: three processes over loopback TCP for each
//     update's proof, started for that update and ended with it;
//   - x9-runner (rust/): deploy, hold, share, leaves and the send- modes.
// - The owners: kohaku-rs's exit_receive, exit_check and exit_redeem, each owner on a seed of its
//   own.
// - The holder: exit_intent, with the funding key, which also deposits the held notes.
// Keys, seeds, notes, shares and the members' files live in a temporary directory deleted at the
// end. The record holds none of them, and it is searched for each one before it is written.
// usage: npx tsx experiments/14-x9-exit-without-permission/run.ts [attempt-label]
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Hex, bytesToHex, concatHex, getAddress, slice } from 'viem'
import { english, generateMnemonic, generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  COMMITTEE_DIR, type Node, type Pin, RPC_URL, buildSkandha, chainFacts, checkout, linesNaming, loadKey, peersOf,
  rpc, rpcUrlOf, run, startNode, stopNode, until, writeConfig,
} from '../../src/e2e/index.js'
import { SELECTORS, TOPICS } from '../../src/e2e/x9.js'
// @ts-expect-error: a plain ES module beside the contract
import { compile } from './contracts/compile.mjs'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8')) as Record<string, Pin>
const work = join(root, 'work')
const attempt = process.argv.slice(2).find((x) => !x.startsWith('--')) ?? new Date().toISOString()
const { privateKey, address: holder } = loadKey()

const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
const dirty = (await run('git', ['status', '--porcelain', '--', 'committee', 'src', 'experiments/14-x9-exit-without-permission'], { cwd: root })).trim()
if (dirty) throw new Error(`commit committee/, src/ and this experiment before a recorded run:\n${dirty}`)
const vaultHex = join(here, 'contracts', 'ExitVault.hex')
if (readFileSync(vaultHex, 'utf8').trim() !== compile()) throw new Error('ExitVault.hex is not what solc makes of the Yul')

// One target directory for every Rust piece, so that their shared dependencies build once.
const target = join(work, 'target-kohaku-all')
const cargoEnv = { CARGO_TARGET_DIR: target }
console.log('checking out and building the pinned pieces')
const skandha = await checkout('skandha', pins.skandha, work)
const kohaku = await checkout('kohaku-rs', pins['kohaku-rs'], work)
await buildSkandha(skandha)
for (const pkg of ['exit-committee', 'co-withdraw']) {
  await run('cargo', ['build', '-q', '--release', '-p', pkg], { cwd: COMMITTEE_DIR, env: cargoEnv })
}
await run('cargo', ['build', '-q', '--release', '--locked', '--manifest-path', join(here, 'rust', 'Cargo.toml')], { cwd: root, env: cargoEnv })
await run('cargo', ['build', '-q', '--release', '-p', 'kohaku-frame-exit', '--examples'], { cwd: join(kohaku, 'crates'), env: cargoEnv })
const bin = (name: string) => join(target, 'release', name)
const example = (name: string) => join(target, 'release', 'examples', name)
const [committeeBin, coWithdraw, runner] = [bin('exit-committee'), bin('co-withdraw'), bin('x9-runner')]

// Every secret of the run lives here only, and is deleted at the end.
const secrets = mkdtempSync(join(tmpdir(), 'x9-'))
const committeeDir = join(secrets, 'committee')
const payerKey = generatePrivateKey()
const payer = privateKeyToAccount(payerKey).address

type Out = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
/** Every process this runner has started and not yet seen end: the committee has stopped when none is a member. */
const live = new Set<number>()
type Ran = { code: number; out: Out; millis: number }

/**
 * Runs one step's command in the secrets directory. Standard output is the step's JSON. Of
 * standard error, only lines that name no note are kept, and only on failure. Exit codes other
 * than `ok` throw.
 */
function exec(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}, ok: number[] = [0]): Promise<Ran> {
  const t = Date.now()
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: secrets, env: { ...process.env, RUST_BACKTRACE: '0', RUST_LIB_BACKTRACE: '0', ...env } })
    live.add(child.pid ?? -1)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => {
      live.delete(child.pid ?? -1)
      const tail = stderr.split('\n').filter((l) => l.trim() && !/note 0x|mnemonic|PRIVATE_KEY|PAYER_KEY/i.test(l)).slice(-8).join('\n')
      if (!ok.includes(code ?? -1)) return reject(new Error(`${cmd.split('/').pop()} ${args[0] ?? ''} exited ${code}\n${tail}\n${stdout.slice(-2000)}`))
      let out: Out = {}
      const text = stdout.trim()
      if (text) {
        try {
          out = JSON.parse(text)
        } catch {
          const last = text.split('\n').reverse().find((l) => l.trim().startsWith('{'))
          out = last ? JSON.parse(last) : { stdout: text.split('\n').slice(-5) }
        }
      }
      resolve({ code: code ?? -1, out, millis: Date.now() - t })
    })
  })
}

const committee = (args: string[]) => exec(committeeBin, args)
const x9 = (args: string[], env: NodeJS.ProcessEnv = {}) => exec(runner, args, { RPC_URL, ...env })

/** A view of the vault, by `eth_call`. */
let vault: Hex = '0x'
const view = async (selector: Hex, arg?: Hex) =>
  BigInt(await rpc('eth_call', [{ to: vault, data: arg ? concatHex([selector, arg]) : selector }, 'latest']))
const head = async () => Number(BigInt(await rpc('eth_blockNumber', [])))
const vaultState = async () => ({
  block: await head(),
  mode: Number(await view(SELECTORS.mode as Hex)),
  head: Number(await view(SELECTORS.head as Hex)),
  tail: Number(await view(SELECTORS.tail as Hex)),
  since: Number(await view(SELECTORS.since as Hex)),
  escapeAt: Number(await view(SELECTORS.escapeAt as Hex)),
  redeemed: Number(await view(SELECTORS.redeemed as Hex)),
  nextIndex: Number(await view(SELECTORS.nextIndex as Hex)),
})

/** Every frame a node and the chain see, with its receipt, as experiment 07 records them. */
async function frameFacts(hash: string) {
  const [tx, rc] = await Promise.all([rpc('eth_getTransactionByHash', [hash]), rpc('eth_getTransactionReceipt', [hash])])
  if (!tx) return null
  return {
    sender: tx.sender as string,
    nonceKeys: tx.nonceKeys as string[],
    nonceSeq: tx.nonceSeq as string,
    signatures: (tx.signatures ?? []).length as number,
    frames: (tx.frames as Record<string, string>[]).map((f, i) => ({
      mode: f.mode,
      flags: f.flags,
      to: f.to,
      gasLimit: f.gasLimit,
      stateGasLimit: f.stateGasLimit,
      value: f.value,
      dataBytes: (f.data.length - 2) / 2,
      selector: f.data.length >= 10 ? f.data.slice(0, 10) : null,
      gasUsed: rc?.frameReceipts?.[i]?.gasUsed ?? null,
      stateGasUsed: rc?.frameReceipts?.[i]?.stateGasUsed ?? null,
      status: rc?.frameReceipts?.[i]?.status ?? null,
    })),
  }
}

/** What the run saw, step by step. A `raw` encoding is dropped here: the chain keeps it. */
const steps: Out[] = []
const record = (plan: string, what: string, ran: Ran, extra: Out = {}): Out => {
  const { raw: _, ...out } = ran.out
  const entry: Out = { plan, what, exit: ran.code, millis: ran.millis, ...out, ...extra }
  steps.push(entry)
  console.log(`[${plan}] ${what}: ${JSON.stringify(summary(entry))}`)
  return entry
}
const summary = (e: Out) => ({
  outcome: e.outcome ?? (e.mined ? `mined, status ${e.mined.status}` : e.node?.error ? 'refused' : undefined),
  block: e.block ?? e.mined?.block,
  modeBefore: e.modeBefore,
  modeAfter: e.modeAfter,
  verdict: e.verdict,
})

const owners = [0, 1, 2].map((i) => ({ seed: join(secrets, `owner-${i}.seed`), receive: join(secrets, `receive-${i}.json`) }))
const held = [0, 1, 2, 3].map((k) => join(secrets, `held-${k}.note`))
let salt: Hex = '0x'
const ownerEnv = (i: number, extra: NodeJS.ProcessEnv = {}) =>
  ({ SEED_FILE: owners[i].seed, VAULT: vault, O: '0', J: '0', RPC_URL, ...extra }) as NodeJS.ProcessEnv

/** The sealed intent at `index`, from its Intent log. */
async function sealedIntent(index: number): Promise<Hex> {
  const logs = await rpc('eth_getLogs', [{ address: vault, topics: [TOPICS.Intent], fromBlock: '0x0', toBlock: 'latest' }])
  const log = (logs as { data: Hex }[]).find((l) => BigInt(slice(l.data, 0, 32)) === BigInt(index))
  if (!log) throw new Error(`no Intent log for index ${index}`)
  return slice(log.data, 96, 96 + 116)
}

/** The committee's side of an update for the intent at `index`, up to the recipient. */
async function prepare(index: number) {
  const t = Date.now()
  const sealed = await sealedIntent(index)
  for (const j of [0, 1, 2]) await committee(['open-intent', '--dir', committeeDir, '--member', `${j}`, '--vault', vault, '--index', `${index}`, '--sealed', sealed])
  const points: Hex[] = []
  for (const j of [0, 1, 2]) points.push((await committee(['part', '--dir', committeeDir, '--member', `${j}`, '--index', `${index}`])).out.point)
  const c: Hex = (await committee(['commit', '--dir', committeeDir, '--index', `${index}`, '--parts', points.join(',')])).out.commitment
  const leaf = Number(await view(SELECTORS.nextIndex as Hex))
  const openings: Hex[] = []
  for (const j of [0, 1, 2]) openings.push((await committee(['seal', '--dir', committeeDir, '--member', `${j}`, '--vault', vault, '--index', `${index}`, '--leaf', `${leaf}`])).out.opening)
  const r = (await committee(['recipient', '--vault', vault, '--sealed', sealed, '--c', c, '--openings', concatHex(openings)])).out
  return { index, c, leaf, openings: concatHex(openings), recipient: r.recipient as Hex, intentHash: r.intentHash as Hex, millis: Date.now() - t }
}

let port = 10_400
/** The holder shares `note`'s witness; three member processes prove it for the prepared update. */
async function prove(prep: Awaited<ReturnType<typeof prepare>>, note: string) {
  const t = Date.now()
  const dir = join(secrets, `shares-${prep.index}-${Date.now()}`)
  const shared = await x9(['share', '--vault', vault, '--note', note, '--out-dir', dir])
  const peers = [0, 1, 2].map((j) => `127.0.0.1:${port + j}`).join(',')
  port += 10
  const members = await Promise.all([0, 1, 2].map((j) =>
    exec(coWithdraw, ['member', '--id', `${j}`, '--share', join(dir, `share-${j}.bin`), '--peers', peers, '--recipient', prep.recipient, '--out', join(dir, `member-${j}.json`)])))
  const records = [0, 1, 2].map((j) => JSON.parse(readFileSync(join(dir, `member-${j}.json`), 'utf8')))
  rmSync(dir, { recursive: true, force: true })
  if (!records.every((m) => m.solidity === records[0].solidity && m.verified)) throw new Error('the members disagree, or the proof does not verify')
  if (BigInt(records[0].publicInputs[2]) !== BigInt(prep.recipient)) throw new Error('the proof is not for the update\'s recipient')
  const data = (await committee(['update-data', '--proof', records[0].solidity, '--root', shared.out.root, '--nullifier-hash', shared.out.nullifierHash, '--c', prep.c, '--openings', prep.openings])).out
  return {
    nullifierHash: shared.out.nullifierHash as Hex,
    root: shared.out.root as Hex,
    verifyData: data.verifyData as Hex,
    processData: data.processData as Hex,
    proveMillis: Math.max(...members.map((m) => m.millis)),
    millis: Date.now() - t,
    members: records.map((m) => ({ member: m.member, verified: m.verified, publicInputs: m.publicInputs, peers: m.peers, proveMs: m.proveMs, network: m.network })),
  }
}

const toA = (a: Node) => ({ SEND_RPC_URL: rpcUrlOf(a) })
const sendUpdate = (a: Node, p: Awaited<ReturnType<typeof prove>>) =>
  x9(['send-update', '--vault', vault, '--nullifier-hash', p.nullifierHash, '--verify-data', p.verifyData, '--process-data', p.processData], { PAYER_KEY: payerKey, ...toA(a) })
const redeemedHashes = async (): Promise<Hex[]> =>
  ((await rpc('eth_getLogs', [{ address: vault, topics: [TOPICS.Redeemed], fromBlock: '0x0', toBlock: 'latest' }])) as { data: Hex }[]).map((l) => slice(l.data, 0, 32))
async function reconcile(a: Node) {
  const escapeAt = Number(await view(SELECTORS.escapeAt as Hex))
  const list = await redeemedHashes()
  const chainId = Number(BigInt(await rpc('eth_chainId', [])))
  const signed = (await committee(['reconcile', '--dir', committeeDir, '--chain-id', `${chainId}`, '--vault', vault, '--escape-at', `${escapeAt}`, '--nullifier-hashes', list.join(',')])).out
  const sent = await x9(['send-reconcile', '--vault', vault, '--escape-at', `${escapeAt}`, '--verify-data', signed.verifyData], { PAYER_KEY: payerKey, ...toA(a) })
  return { sent, escapeAt, listed: list.length, signers: signed.signers, digest: signed.digest }
}
const untilBlock = (n: number, what: string) => until(what, async () => ((await head()) >= n ? true : undefined), 30 * 60_000, 2_000)
const fresh = () => getAddress(bytesToHex(randomBytes(20)))


const stamp = Date.now()
const config = join(work, `hegota-${stamp}.json`)
writeConfig(config)
const nodes: Node[] = []
const progress: Out = {}
const secretStrings: string[] = [privateKey, payerKey]
try {
  const balance = BigInt(await rpc('eth_getBalance', [holder, 'latest']))
  if (balance < 60_000_000_000_000_000n) throw new Error(`the funding account holds ${balance} wei; the run needs 0.06 ETH`)

  // 1. Two nodes, peered with each other only.
  const a = await startNode({
    dir: skandha, name: 'A', config, dataDir: join(work, `a-${stamp}`), apiPort: 14337, wsPort: 14437, p2pPort: 14000,
    log: join(work, `a-${stamp}.frames.jsonl`), out: join(work, `a-${stamp}.out`),
  })
  nodes.push(a)
  const b = await startNode({
    dir: skandha, name: 'B', config, dataDir: join(work, `b-${stamp}`), apiPort: 14338, wsPort: 14438, p2pPort: 14001,
    log: join(work, `b-${stamp}.frames.jsonl`), out: join(work, `b-${stamp}.out`), bootEnr: a.enr, handoff: true,
  })
  nodes.push(b)
  const peers = await until('the two nodes to peer, each with the other alone', async () => {
    const [pa, pb] = await Promise.all([peersOf(a), peersOf(b)])
    return pa.length === 1 && pa[0] === b.peerId && pb.length === 1 && pb[0] === a.peerId ? { a: pa, b: pb } : undefined
  }, 120_000)
  console.log(`A ${a.peerId}, B ${b.peerId}: peered`)

  // Set-up, to the chain directly: the committee's keys, the vault, the payer, four held notes,
  // and three owners, each with a seed of its own and a receiving address for its holder.
  const keys = await committee(['keys', '--dir', committeeDir])
  salt = bytesToHex(randomBytes(32))
  const init = await committee(['initcode', '--dir', committeeDir, '--hex', vaultHex, '--salt', salt])
  writeFileSync(join(secrets, 'initcode.json'), JSON.stringify(init.out))
  const deployed = await x9(['deploy', '--initcode', join(secrets, 'initcode.json'), '--salt', salt, '--payer', payer], { PRIVATE_KEY: privateKey })
  vault = getAddress(deployed.out.vault)
  const { initcode: _, ...initPublic } = init.out
  progress.setup = { committee: keys.out, initcode: initPublic, deployed: deployed.out }
  const T = Number(await view(SELECTORS.timeout as Hex))
  const E = Number(await view(SELECTORS.escapeWindow as Hex))
  const holds: Out[] = []
  for (const note of held) {
    holds.push((await x9(['hold', '--vault', vault, '--salt', salt, '--note', note], { PRIVATE_KEY: privateKey })).out)
    const preimage = readFileSync(note, 'utf8').trim()
    secretStrings.push(preimage, preimage.slice(0, 62), preimage.slice(62))
  }
  progress.setup.holds = holds
  const receives: Out[] = []
  for (const [i, o] of owners.entries()) {
    const phrase = generateMnemonic(english)
    writeFileSync(o.seed, phrase)
    chmodSync(o.seed, 0o600)
    secretStrings.push(phrase)
    receives.push(record('setup', `owner ${i}'s receiving address, for its holder`, await exec(example('exit_receive'), [], { ...ownerEnv(i), RECEIVE_FILE: o.receive })))
    const r = JSON.parse(readFileSync(o.receive, 'utf8'))
    secretStrings.push(r.openingKey, r.secretPoint)
  }
  console.log(`vault ${vault}, T ${T}, E ${E}`)

  // 2. Normal mode: the holder sends each intent for its new owner, the committee processes it
  // and publishes the openings, and the owner checks its opening against the note in the vault.
  const updates: Out[] = []
  for (const i of [0, 1]) {
    const intent = record('2', `the holder's intent for owner ${i}`, await exec(example('exit_intent'), [], { PRIVATE_KEY: privateKey, VAULT: vault, RECEIVE_FILE: owners[i].receive, RPC_URL, ...toA(a) }, [0, 1]))
    if (intent.outcome !== 'Queued') throw new Error(`intent ${i}: ${intent.outcome}`)
    const prep = await prepare(i)
    const p = await prove(prep, held[i])
    const sent = record('2', `the committee's update ${i}, spending held note ${i}`, await sendUpdate(a, p), {
      intentBlock: intent.block, leaf: prep.leaf, prepareMillis: prep.millis, proveMillis: p.proveMillis, committeeMillis: prep.millis + p.millis,
      nullifierHash: p.nullifierHash, members: p.members,
    })
    updates.push(sent)
    if (sent.mined?.status !== '0x1' && sent.mined?.status !== 1) throw new Error(`update ${i} was not mined with success`)
    record('2', `owner ${i} checks its opening`, await exec(example('exit_check'), [], ownerEnv(i), [0, 2, 3]))
  }
  progress.normal = steps.slice()

  // 3. Too early: the holder queues the intent for owner 2, the queue stalls, and owner 0
  // redeems at once. It must pay nothing.
  const third = record('3', 'the holder\'s intent for owner 2, which nobody processes', await exec(example('exit_intent'), [], { PRIVATE_KEY: privateKey, VAULT: vault, RECEIVE_FILE: owners[2].receive, RPC_URL, ...toA(a) }, [0, 1]))
  if (third.outcome !== 'Queued') throw new Error(`intent 2: ${third.outcome}`)
  const stalled = await vaultState()
  const early = record('3', 'owner 0 redeems before T blocks, sequence 0', await exec(example('exit_redeem'), [], ownerEnv(0, { SALT: salt, SEQ: '0', ...toA(a) }), [0, 1, 2, 3]), {
    since: stalled.since, deadline: stalled.since + T,
  })
  early.beforeT = typeof early.block === 'number' && early.block < stalled.since + T

  // 4. The committee stops: no member process runs from here on, and the head stays put for T
  // blocks.
  const stopped = { processesRunning: live.size, ...(await vaultState()) }
  await untilBlock(stalled.since + T, `block ${stalled.since + T}, T blocks after the queue stalled`)
  steps.push({ plan: '4', what: 'the committee stopped; T blocks passed', stopped, after: await vaultState() })

  // 5. The escape. First the members, together, with everything they hold, for owner 0's note.
  const leaves = (await x9(['leaves', '--vault', vault])).out.leaves as Hex[]
  const stealTo = fresh()
  const steal = await committee(['steal', '--dir', committeeDir, '--index', '0', '--leaves', leaves.join(','), '--to', stealTo])
  steps.push({ plan: '5', what: 'the members pool everything they hold for owner 0\'s note', ...steal.out })
  // At the key's current sequence: 1 if the early attempt was mined, as it should be.
  const stealSeq = early.outcome === 'PaidNothing' || early.outcome === 'Paid' ? 1 : 0
  record('5', `the members' redemption of owner 0's note, with no proof, sequence ${stealSeq}`, await x9(['send-redemption', '--vault', vault, '--salt', salt, '--to', stealTo,
    '--seq', `${stealSeq}`, '--nullifier-hash', steal.out.redemptionToTry.nullifierHash], toA(a)))

  // The owners redeem, the vault their sender and payer. The first opens escape mode, and the
  // committee at once tries to close it, before E blocks.
  record('5', 'owner 0 redeems, sequence 1', await exec(example('exit_redeem'), [], ownerEnv(0, { SALT: salt, SEQ: '1', ...toA(a) }), [0, 1, 2, 3]))
  const tooSoon = await reconcile(a)
  record('5', 'the committee reconciles at once, before E blocks', tooSoon.sent, { escapeAt: tooSoon.escapeAt, listed: tooSoon.listed })
  record('5', 'owner 1 redeems, sequence 0', await exec(example('exit_redeem'), [], ownerEnv(1, { SALT: salt, SEQ: '0', ...toA(a) }), [0, 1, 2, 3]))
  // The fix's check: the previous holder of the note update 0 spent, at that key's next sequence.
  record('5', 'the previous holder redeems the note update 0 spent, sequence 1', await x9(['send-redemption', '--vault', vault, '--salt', salt, '--to', fresh(),
    '--seq', '1', '--note', held[0]], toA(a)))
  record('5', 'holder 3 redeems its own note, sequence 0', await x9(['send-redemption', '--vault', vault, '--salt', salt, '--to', fresh(), '--seq', '0', '--note', held[3]], toA(a)))
  record('5', 'owner 0 redeems again, sequence 2', await exec(example('exit_redeem'), [], ownerEnv(0, { SALT: salt, SEQ: '2', ...toA(a) }), [0, 1, 2, 3]))
  steps.push({ plan: '5', what: 'the vault after the escape', ...(await vaultState()) })

  // 6. The return: the committee restarts, and its updates for the head intent are refused in
  // escape mode, the second because its note was redeemed. Then it reconciles after E blocks, the
  // update over the redeemed note is refused again, and the queue is processed.
  const prep2 = await prepare(2)
  const overHeld = await prove(prep2, held[2])
  record('6', 'the committee\'s update for intent 2 in escape mode', await sendUpdate(a, overHeld), { nullifierHash: overHeld.nullifierHash })
  const overRedeemed = await prove(prep2, held[3])
  record('6', 'the committee\'s update spending holder 3\'s redeemed note, in escape mode', await sendUpdate(a, overRedeemed), { nullifierHash: overRedeemed.nullifierHash })
  const escapeAt = Number(await view(SELECTORS.escapeAt as Hex))
  await untilBlock(escapeAt + E, `block ${escapeAt + E}, E blocks after escape opened`)
  const rec = await reconcile(a)
  record('6', 'the committee reconciles, every redemption listed', rec.sent, { escapeAt: rec.escapeAt, listed: rec.listed, signers: rec.signers })
  record('6', 'the update spending holder 3\'s redeemed note, after reconciling', await sendUpdate(a, overRedeemed), { nullifierHash: overRedeemed.nullifierHash })
  const prep3 = await prepare(2)
  const queue = await prove(prep3, held[2])
  record('6', 'the queue processed again: update 2, spending held note 2', await sendUpdate(a, queue), {
    leaf: prep3.leaf, committeeMillis: prep3.millis + queue.millis, nullifierHash: queue.nullifierHash,
  })
  record('6', 'owner 2 checks its opening', await exec(example('exit_check'), [], ownerEnv(2), [0, 2, 3]))
  steps.push({ plan: '6', what: 'the vault at the end', ...(await vaultState()) })

  // 7. The record: every transaction's node lines and chain facts.
  const hashes = [...new Set(steps.flatMap((s) => [s.hash, s.mined?.hash]).filter(Boolean).map((h: string) => h.toLowerCase()))]
  const mined: string[] = []
  for (const h of hashes) if ((await chainFacts(h)).mined) mined.push(h)
  const removed = (n: Node, h: string) =>
    linesNaming(n.log, h).some((l) => l.event === 'head' && (l.removed as string[]).map((x) => x.toLowerCase()).includes(h))
  const seenByBoth = await until('both nodes to remove every mined transaction as included', async () =>
    mined.every((h) => removed(a, h) && removed(b, h)) ? true : undefined, 180_000).catch(() => false)
  const startLine = (n: Node) =>
    readFileSync(n.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.event === 'start')

  // The sixth condition's first half: no owner's opening key in any transaction or log.
  const openingKeys = owners.map((o) => JSON.parse(readFileSync(o.receive, 'utf8')).openingKey.slice(2).toLowerCase() as string)
  const onChain = await Promise.all(hashes.map(async (h) => {
    const [tx, rc] = await Promise.all([rpc('eth_getTransactionByHash', [h]), rpc('eth_getTransactionReceipt', [h])])
    return JSON.stringify([tx, rc]).toLowerCase()
  }))
  const openingKeyOnChain = openingKeys.map((k) => onChain.some((t) => t.includes(k)))

  const run7 = {
    experiment: '14-x9-exit-without-permission',
    attempt,
    ranAt: new Date().toISOString(),
    repoCommit,
    pins: Object.fromEntries(Object.entries(pins).map(([k, p]) => [k, { url: p.url, commit: p.commit }])),
    client: await rpc('web3_clientVersion', []),
    network: 'the committee: three member processes on one machine over loopback TCP, a LAN time at best; the nodes: two processes on one machine over loopback',
    commands: [
      'npx tsx experiments/14-x9-exit-without-permission/run.ts',
      'skandha: node A with --frames.enable, node B with --frames.enable and --frames.handoff, booted from A',
      'committee/exit-committee: keys, initcode, open-intent, part, commit, seal, recipient, update-data, reconcile, steal',
      'committee/co-withdraw: member --recipient, three processes per update',
      'x9-runner: deploy and hold to the chain; share and leaves; send-update, send-reconcile and send-redemption with SEND_RPC_URL at node A',
      `kohaku-rs ${pins['kohaku-rs'].commit.slice(0, 7)}: exit_receive and exit_check; exit_intent and exit_redeem with SEND_RPC_URL at node A`,
    ],
    parameters: { timeout: T, escapeWindow: E, batchSize: 1, owners: owners.length, heldNotes: held.length, holder, payer },
    setup: progress.setup,
    owners: receives.map((r) => ({ recipient: r.recipient })),
    steps,
    openingKeyOnChain,
    nodes: [
      { name: 'A', peerId: a.peerId, handoff: false, peers: peers.a, start: startLine(a),
        lines: Object.fromEntries(hashes.map((h) => [h, linesNaming(a.log, h)])) },
      { name: 'B', peerId: b.peerId, handoff: true, peers: peers.b, start: startLine(b),
        lines: Object.fromEntries(hashes.map((h) => [h, linesNaming(b.log, h)])) },
    ],
    seenByBoth,
    chain: Object.fromEntries(await Promise.all(hashes.map(async (h) => [h, { ...(await chainFacts(h)), frames: (await frameFacts(h))?.frames ?? null }]))),
  }
  const text = JSON.stringify(run7, null, 2) + '\n'
  const leaked = secretStrings.concat(memberSecrets()).filter((s) => s && text.toLowerCase().includes(s.replace(/^0x/, '').toLowerCase()))
  if (leaked.length) throw new Error(`the record holds ${leaked.length} secret value(s); not written`)
  const results = join(here, 'results')
  mkdirSync(results, { recursive: true })
  const path = join(results, `${attempt.replace(/[^A-Za-z0-9-]/g, '-')}.json`)
  writeFileSync(path, text)
  console.log(`recorded ${path}`)
} catch (e) {
  const failed = join(here, 'results', 'failed')
  mkdirSync(failed, { recursive: true })
  const path = join(failed, `${attempt.replace(/[^A-Za-z0-9-]/g, '-')}.json`)
  const message = (e as Error).message.split('\n').filter((l) => !/note 0x|mnemonic|PRIVATE_KEY|PAYER_KEY/i.test(l))
  let text = JSON.stringify({ experiment: '14-x9-exit-without-permission', attempt, failedAt: new Date().toISOString(), repoCommit, vault, failed: message, steps }, null, 2) + '\n'
  const secretsNow = secretStrings.concat(memberSecrets())
  for (const s of secretsNow) if (s) text = text.split(s.replace(/^0x/, '')).join('[secret]')
  writeFileSync(path, text)
  console.log(`failed; what finished is in ${path}`)
  throw e
} finally {
  for (const n of nodes.reverse()) await stopNode(n.child)
  rmSync(secrets, { recursive: true, force: true })
}

/** Every file a member keeps: its sealing key, BLS share, parts and the intents it opened. */
function memberSecrets(): string[] {
  const out: string[] = []
  for (const j of [0, 1, 2]) {
    const d = join(committeeDir, `member-${j}`)
    try {
      for (const f of readdirSync(d)) out.push(readFileSync(join(d, f), 'utf8').trim())
    } catch {}
  }
  return out
}

