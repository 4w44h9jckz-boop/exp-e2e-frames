// Experiment 15 (X10): the contracts, notes, trees, proofs and frame transactions. Addresses come
// from CREATE2 with label salts and note secrets from PRIVATE_KEY, so every script sees the same
// contracts and the same notes.
import { readFileSync } from 'node:fs'
import { buildMimcSponge } from 'circomlibjs'
import * as snarkjs from 'snarkjs'
import {
  type Address,
  type Hex,
  type PublicClient,
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hexToBigInt,
  keccak256,
  numberToHex,
  pad,
  parseAbi,
  parseAbiItem,
  toHex,
} from 'viem'
import { compileSolidity, compileYul } from '../../src/exp-frames/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/exp-frames/deploy.js'
import {
  Approve,
  type Frame,
  type FrameTx,
  type FrameTxFees,
  Mode,
  NEW_ACCOUNT_STATE_GAS,
  NONCE_MANAGER,
  RECENT_ROOT,
  STORAGE_SET_STATE_GAS,
  keyedNonceSlot,
  senderFrame,
  verifyFrame,
} from '../../src/exp-frames/frametx/index.js'

export const DIR = 'experiments/15-x10-out-and-back'
const here = (f: string) => new URL(f, import.meta.url).pathname

/** BN254's scalar field, Tornado's FIELD_SIZE. */
export const FIELD = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n
export const ETH_TAG = 0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeen
export const ETH = getAddress('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')

const word = (x: bigint | number | string) => numberToHex(BigInt(x), { size: 32 })
/**
 * Which deployment: every contract's salt and every note's secrets carry it, so a pass that
 * stops partway is rerun on fresh contracts and notes rather than continued.
 */
export const DEPLOYMENT = process.env.X10_DEPLOYMENT ?? 'd1'
const label = (l: string) => saltOf(`exp-e2e-frames/15/${DEPLOYMENT}/${l}`)

/** Base fee sits at 7 wei on the testnet; a 1 wei tip is enough. As exp-frames experiment 06. */
export const FEES: FrameTxFees = { maxPriorityFeePerGas: 1n, maxFeePerGas: 100n, maxFeePerBlobGas: 0n }
/** What a spend of ether pays the registry, bound by its proof: as exp-frames 06 and 32. */
export const FEE = 10n ** 10n
export const DENOMINATION = 10n ** 15n

// ---- contracts ----

type Vkey = { nPublic: number; vk_alpha_1: string[]; vk_beta_2: string[][]; vk_gamma_2: string[][]; vk_delta_2: string[][]; IC: string[][] }
export const CIRCUITS = ['kernel', 'import', 'batch8', 'round4'] as const
export type Circuit = (typeof CIRCUITS)[number]
export const VKEYS = Object.fromEntries(CIRCUITS.map((c) => [c, JSON.parse(readFileSync(here(`build/${c}.vkey.json`), 'utf8')) as Vkey])) as Record<Circuit, Vkey>

const g1 = (p: string[]) => [word(p[0]), word(p[1])]
/** A G2 point in EIP-197's order: x1, x0, y1, y0. */
const g2 = (p: string[][]) => [word(p[0][1]), word(p[0][0]), word(p[1][1]), word(p[1][0])]

type Fixed = { label: string; initcode: Hex; salt: Hex; address: Address; deploy: Frame }
const fixed = (initcode: Hex, l: string, constructorState = 0n): Fixed => {
  const code = initcode.toLowerCase() as Hex
  const salt = label(l)
  return { label: l, initcode: code, salt, address: create2Address(code, salt), deploy: deployFrame(code, salt, constructorState).frame }
}

const verifierCode = compileYul(`${DIR}/contracts/Groth16Verifier.yul`)
export const verifiers = Object.fromEntries(
  CIRCUITS.map((c) => {
    const vk = VKEYS[c]
    const initcode = concatHex([verifierCode, ...g1(vk.vk_alpha_1), ...g2(vk.vk_beta_2), ...g2(vk.vk_gamma_2), ...g2(vk.vk_delta_2), ...vk.IC.flatMap(g1), word(vk.nPublic)])
    return [c, fixed(initcode, `verifier/${c}`)]
  }),
) as Record<Circuit, Fixed>

/** Experiment 06's MiMC hasher, already on the testnet. */
export const HASHER_INITCODE = (JSON.parse(readFileSync(here('vendor/hasher.json'), 'utf8')) as { bytecode: Hex }).bytecode
export const HASHER = create2Address(HASHER_INITCODE, saltOf('exp-frames/06/hasher'))

const sol = (name: string) => compileSolidity(`${DIR}/contracts/Amm.sol`, name)
export const tokenC = sol('TestToken')
export const ammC = sol('Amm')
export const relayC = sol('Relay')
export const probeC = sol('Probe')
const withArgs = (bytecode: Hex, types: { type: string }[], values: unknown[]) => concatHex([bytecode, encodeAbiParameters(types, values as never)])

export const token = fixed(tokenC.bytecode, 'token')
export const amm = fixed(withArgs(ammC.bytecode, [{ type: 'address' }], [token.address]), 'amm')
export const relay = fixed(relayC.bytecode, 'relay')
export const PROBES = ['underpay', 'twice', 'relay', 'silent'] as const
export type ProbeKind = (typeof PROBES)[number]
export const probes = Object.fromEntries(
  PROBES.map((k, i) => [k, fixed(withArgs(probeC.bytecode, [{ type: 'address' }, { type: 'uint256' }, { type: 'address' }], [token.address, BigInt(i), relay.address]), `probe/${k}`)]),
) as Record<ProbeKind, Fixed>

export const MODE = { TREE: 0n, APPEND: 1n } as const
const registryCode = compileYul(`${DIR}/contracts/Registry.yul`)
function registryOf(mode: bigint, l: string) {
  const rootSalt = keccak256(toHex(`exp-e2e-frames/15/${DEPLOYMENT}/${l}`))
  const initcode = concatHex([
    registryCode,
    pad(verifiers.round4.address),
    pad(verifiers.batch8.address),
    pad(verifiers.import.address),
    pad(verifiers.kernel.address),
    pad(HASHER),
    word(mode),
    rootSalt,
  ])
  const f = fixed(initcode, l, mode === MODE.APPEND ? STORAGE_SET_STATE_GAS : 0n)
  return { ...f, mode, rootSalt, sourceId: keccak256(concatHex([f.address, rootSalt])) }
}
/** R0 and R1 insert into the tree on chain; R2 and R3 append and batch. */
export const treeRegistry = registryOf(MODE.TREE, 'registry/tree')
export const appendRegistry = registryOf(MODE.APPEND, 'registry/append')
export type Registry = typeof treeRegistry

export const registryAbi = parseAbi([
  'function deposit(bytes32 inner) payable',
  'function processPrivateTransaction(bytes32 root, uint256 kind, uint256[] words)',
  'function advanceRoot(uint256[] words)',
  'function completeImport(uint256 value)',
  'function registerImportReceipt(address depositor, bytes32 value, bytes32 commitmentHash) returns (bytes32)',
  'function claim(address who)',
  'function republish()',
  'function root() view returns (bytes32)',
  'function leafCount() view returns (uint256)',
  'function batchedCount() view returns (uint256)',
  'function accumulator() view returns (bytes32)',
  'function receiptOf(bytes32 id) view returns (uint256)',
  'function owed(address who) view returns (uint256)',
  'function sourceId() view returns (bytes32)',
  'function mode() view returns (uint256)',
])
export const EVENTS = {
  appended: parseAbiItem('event CommitmentAppended(bytes32 leaf, uint256 index)'),
  recentRoot: parseAbiItem('event RecentRoot(bytes32 root, uint64 slot)'),
  receipt: parseAbiItem('event ImportReceiptCreated(bytes32 indexed receiptId, address indexed sourceContract, address indexed depositor, bytes32 value, bytes32 commitmentHash)'),
  completed: parseAbiItem('event ImportCompleted(bytes32 indexed partialNote, uint256 value, bytes32 leaf)'),
  refunded: parseAbiItem('event Refunded(bytes32 indexed nullifier, bytes32 refund)'),
  spent: parseAbiItem('event Spent(bytes32 indexed nullifier, address tag, uint256 amountOut, uint256 how, address to)'),
  claimed: parseAbiItem('event ReceiptClaimed(bytes32 indexed receiptId, bytes32 leaf)'),
} as const
export const tokenAbi = parseAbi(['function mint(address to, uint256 amount)', 'function balanceOf(address) view returns (uint256)'])
export const ammAbi = parseAbi(['function addEther() payable', 'function quote(uint256 amountIn) view returns (uint256)'])

// ---- notes ----

const mimc = await buildMimcSponge()
/** circomlib's MiMCSponge(n, 220, 1) with key 0: the circuits' H, and the deployed hasher's. */
export const H = (...xs: bigint[]): bigint => mimc.F.toObject(mimc.multiHash(xs, 0n, 1))

export type Secrets = { nullifierSecret: bigint; secret: bigint }
/** A note's secrets, from PRIVATE_KEY and a label. */
export function secretsOf(base: Hex, l: string): Secrets {
  const f = (part: string) => hexToBigInt(keccak256(concatHex([base, toHex(`exp-e2e-frames/15/${DEPLOYMENT}/note/${l}/${part}`)]))) % FIELD
  return { nullifierSecret: f('nullifier'), secret: f('secret') }
}
export const innerOf = (s: Secrets) => H(s.nullifierSecret, s.secret)
export const tagOf = (a: Address) => hexToBigInt(a)
export const leafOf = (tag: bigint, inner: bigint, value: bigint) => H(tag, inner, value)
export const nullifierOf = (tag: bigint, s: Secrets) => H(tag, s.nullifierSecret)
/** A round's output and refund notes are fixed by the owner's secret (round4.circom). */
export const roundOutSecrets = (s: Secrets): Secrets => ({ nullifierSecret: s.secret, secret: 1n })
export const roundRefundSecrets = (s: Secrets): Secrets => ({ nullifierSecret: s.secret, secret: 2n })

// ---- the tree ----

export const LEVELS = 20
export const ZEROS: bigint[] = [hexToBigInt(keccak256(toHex('tornado'))) % FIELD]
for (let i = 0; i < LEVELS; i++) ZEROS.push(H(ZEROS[i], ZEROS[i]))

export function treeOf(leaves: bigint[]) {
  const layers: bigint[][] = [leaves]
  for (let l = 0; l < LEVELS; l++) {
    const below = layers[l]
    const up: bigint[] = []
    for (let j = 0; j < below.length; j += 2) up.push(H(below[j], below[j + 1] ?? ZEROS[l]))
    layers.push(up)
  }
  return {
    root: layers[LEVELS][0] ?? ZEROS[LEVELS],
    /** The path of leaf `index`, or of the node at height `height` and position `index`. */
    path(index: number, height = 0) {
      const pathElements: bigint[] = []
      const pathIndices: bigint[] = []
      for (let l = height, i = index; l < LEVELS; l++, i >>= 1) {
        pathElements.push(layers[l][i ^ 1] ?? ZEROS[l])
        pathIndices.push(BigInt(i & 1))
      }
      return { pathElements, pathIndices }
    },
  }
}

// ---- chain reads ----

/** Every leaf the registry added, in order: deposits, change, completions, claims, refunds. */
export async function leavesOf(client: PublicClient, r: Registry): Promise<bigint[]> {
  const logs = await client.getLogs({ address: r.address, event: EVENTS.appended, fromBlock: 'earliest' })
  const out: bigint[] = []
  for (const l of logs) out[Number(l.args.index)] = hexToBigInt(l.args.leaf as Hex)
  if (out.some((x) => x === undefined)) throw new Error('gap in the CommitmentAppended events')
  return out
}

/** The latest EIP-8272 slot in which the registry published `root`. */
export async function rootSlot(client: PublicClient, r: Registry, root: bigint): Promise<bigint | undefined> {
  const logs = await client.getLogs({ address: r.address, event: EVENTS.recentRoot, fromBlock: 'earliest' })
  return logs.filter((l) => hexToBigInt(l.args.root as Hex) === root).at(-1)?.args.slot
}

/**
 * The testnet's RPC sits behind a balancer whose nodes can lag one another, so a read just after
 * a transaction can reach a node that has not seen it. Retry until `f` answers, for a while.
 */
export async function settled<T>(what: string, f: () => Promise<T | undefined>, ms = 120_000): Promise<T> {
  const deadline = Date.now() + ms
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const v = await f()
      if (v !== undefined) return v
    } catch (e) {
      last = e
    }
    await new Promise((res) => setTimeout(res, 3_000))
  }
  throw new Error(`${what}: no settled answer after ${ms} ms${last ? `: ${(last as Error).message.split('\n')[0]}` : ''}`)
}

export async function read(client: PublicClient, r: Registry, fn: 'root' | 'leafCount' | 'batchedCount' | 'accumulator'): Promise<bigint> {
  return settled(`${fn}()`, async () => BigInt(await client.readContract({ address: r.address, abi: registryAbi, functionName: fn })))
}

export async function isUsed(client: PublicClient, r: Registry, key: bigint): Promise<boolean> {
  const v = await client.getStorageAt({ address: NONCE_MANAGER, slot: keyedNonceSlot(r.address, key) })
  return !!v && hexToBigInt(v) > 0n
}

// ---- proofs ----

const decimal = (x: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(x).map(([k, v]) => [k, Array.isArray(v) ? v.map((y) => (Array.isArray(y) ? y.map(String) : String(y))) : String(v)]))

export type Proof = bigint[]
/** snarkjs's proof as the verifier reads it: A.x A.y B.x1 B.x0 B.y1 B.y0 C.x C.y. */
export function proofWords(proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }): Proof {
  const b = proof.pi_b
  return [proof.pi_a[0], proof.pi_a[1], b[0][1], b[0][0], b[1][1], b[1][0], proof.pi_c[0], proof.pi_c[1]].map(BigInt)
}

/** Prove with snarkjs; check the proof against the key and the public signals against `expect`. */
export async function prove(c: Circuit, input: Record<string, unknown>, expect: bigint[]): Promise<{ proof: Proof; ms: number }> {
  const t0 = Date.now()
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(decimal(input), here(`build/${c}_js/${c}.wasm`), here(`build/${c}.zkey`))
  const ms = Date.now() - t0
  if (!(await snarkjs.groth16.verify(VKEYS[c], publicSignals, proof))) throw new Error(`${c}: snarkjs produced a proof its own key refuses`)
  const got = (publicSignals as string[]).map(BigInt)
  if (got.length !== expect.length || got.some((x, i) => x !== expect[i])) throw new Error(`${c}: public signals ${got.join(',')} are not ${expect.join(',')}`)
  return { proof: proofWords(proof), ms }
}

export async function verifyWords(c: Circuit, proof: Proof, inputs: bigint[]): Promise<boolean> {
  const p = proof.map(String)
  const snark = { protocol: 'groth16', curve: 'bn128', pi_a: [p[0], p[1], '1'], pi_b: [[p[3], p[2]], [p[5], p[4]], ['1', '0']], pi_c: [p[6], p[7], '1'] }
  return snarkjs.groth16.verify(VKEYS[c], inputs.map(String), snark)
}

// ---- the spend: kind 1 ----

export const How = { PAYOUT: 0n, COMPLETE: 1n, RECEIPT: 2n } as const

export type Spend = {
  tag: bigint
  secrets: Secrets
  value: bigint
  index: number
  amountOut: bigint
  /** Whose change note, if anything is left. */
  changeInner?: bigint
  /** The refund note's owner, for an export. */
  refundInner?: bigint
  how: bigint
  to: Address
  fee: bigint
  tagOut?: bigint
  /** How 1: innerOut. How 2: H(tagOut, innerOut). */
  partial?: bigint
  minOut?: bigint
}

export const bindingOf = (ws: bigint[]) => hexToBigInt(keccak256(concatHex(ws.map(word)))) >> 8n

export async function spendWords(s: Spend, tree: ReturnType<typeof treeOf>) {
  const { pathElements, pathIndices } = tree.path(s.index)
  const newState = s.value - s.amountOut
  const change = s.changeInner === undefined ? 0n : leafOf(s.tag, s.changeInner, newState)
  const refund = s.refundInner === undefined ? 0n : leafOf(s.tag, s.refundInner, s.amountOut)
  const nullifier = nullifierOf(s.tag, s.secrets)
  const tail = [s.how, hexToBigInt(s.to), s.fee, s.tagOut ?? 0n, s.partial ?? 0n, s.minOut ?? 0n]
  const binding = bindingOf(tail)
  const input = {
    root: tree.root,
    nullifier,
    tag: s.tag,
    amountOut: s.amountOut,
    changeCommitment: change,
    refundCommitment: refund,
    binding,
    nullifierSecret: s.secrets.nullifierSecret,
    secret: s.secrets.secret,
    state: s.value,
    newInner: s.changeInner ?? 0n,
    refundInner: s.refundInner ?? 0n,
    pathElements,
    pathIndices,
  }
  const publics = [tree.root, nullifier, s.tag, s.amountOut, change, refund, binding]
  const { proof, ms } = await prove('kernel', input, publics)
  return { root: tree.root, nullifier, change, refund, words: [nullifier, s.tag, s.amountOut, change, refund, ...tail, ...proof], ms }
}

// ---- the claim: kind 2 (R0) ----

export const receiptIdOf = (partial: bigint, value: bigint, tagOut: bigint) => hexToBigInt(keccak256(concatHex([word(partial), word(value), word(tagOut)])))

export async function claimWords(tagOut: bigint, inner: bigint, value: bigint) {
  const partial = H(tagOut, inner)
  const leaf = leafOf(tagOut, inner, value)
  const { proof, ms } = await prove('import', { partial, tag: tagOut, value, newCommitment: leaf, inner }, [partial, tagOut, value, leaf])
  const id = receiptIdOf(partial, value, tagOut)
  return { id, leaf, words: [id, partial, tagOut, value, leaf, ...proof], ms }
}

// ---- the round: kind 3 (R3) ----

export type Member = { secrets: Secrets; index: number }

/** The round's statement, before anyone proves it: its witness, public inputs and words. */
export function roundStatement(members: Member[], tree: ReturnType<typeof treeOf>, o: { destination: Address; fee: bigint; tagOut: bigint; minOut: bigint }) {
  if (members.length !== 4) throw new Error('a round has four members')
  const rows = members.map((m) => ({ m, nullifier: nullifierOf(ETH_TAG, m.secrets) })).sort((a, b) => (a.nullifier < b.nullifier ? -1 : 1))
  const nullifiers = rows.map((r) => r.nullifier)
  const partials = rows.map((r) => H(r.m.secrets.secret, 1n))
  const refunds = rows.map((r) => leafOf(ETH_TAG, H(r.m.secrets.secret, 2n), DENOMINATION))
  const tail = [hexToBigInt(o.destination), o.fee, o.tagOut, o.minOut]
  const binding = bindingOf(tail)
  const paths = rows.map((r) => tree.path(r.m.index))
  /** What everyone may see: the same in every owner's input file. */
  const pub = {
    root: tree.root,
    denomination: DENOMINATION,
    tag: ETH_TAG,
    nullifier: nullifiers,
    partialInner: partials,
    refundCommitment: refunds,
    binding,
  }
  /** Each owner's own fields, under its own names: what it secret-shares and nothing else. */
  const owners = rows.map((r, k) => ({
    [`m${k}_nullifierSecret`]: r.m.secrets.nullifierSecret,
    [`m${k}_secret`]: r.m.secrets.secret,
    [`m${k}_pathElements`]: paths[k].pathElements,
    [`m${k}_pathIndices`]: paths[k].pathIndices,
  }))
  const witness = Object.assign({}, pub, ...owners) as Record<string, unknown>
  const publics = [tree.root, DENOMINATION, ETH_TAG, ...nullifiers, ...partials, ...refunds, binding]
  const head = [...nullifiers, ...partials, ...refunds, ETH_TAG, DENOMINATION, ...tail]
  return { root: tree.root, nullifiers, partials, refunds, pub, owners, witness, publics, head, order: rows.map((r) => r.m) }
}

// ---- the batch (R2, R3) ----

export async function batchWords(leaves: bigint[], start: number) {
  const batch = leaves.slice(start, start + 8)
  if (batch.length !== 8) throw new Error('a batch is eight leaves')
  const before = treeOf(leaves.slice(0, start))
  const after = treeOf(leaves.slice(0, start + 8))
  const { pathElements } = after.path(start >> 3, 3)
  const input = { oldRoot: before.root, newRoot: after.root, startIndex: BigInt(start), leaves: batch, pathElements }
  const { proof, ms } = await prove('batch8', input, [before.root, after.root, BigInt(start), ...batch])
  return { oldRoot: before.root, newRoot: after.root, words: [BigInt(start), after.root, ...batch, ...proof], ms }
}

// ---- transactions ----

/** EIP-8272's verifier frame: source_id || slot || root. */
export function recentRootFrame(sourceId: Hex, slot: bigint, root: bigint): Frame {
  return {
    mode: Mode.VERIFY,
    flags: Approve.NONE,
    target: RECENT_ROOT,
    limits: { execution: 10_000n, state: 0n },
    value: 0n,
    data: concatHex([sourceId, numberToHex(slot, { size: 8 }), word(root)]),
  }
}

const ppt = (root: bigint, kind: bigint, ws: bigint[]) =>
  encodeFunctionData({ abi: registryAbi, functionName: 'processPrivateTransaction', args: [word(root), kind, ws] })

/** Gas each SENDER frame is given; at least the registry's floors (Registry.yul, "constants"). */
export function senderGas(r: Registry, kind: 'payout' | 'export' | 'claim' | 'round' | 'batch') {
  const leaf = r.mode === MODE.TREE ? 1_200_000n : 60_000n
  const slots = r.mode === MODE.TREE ? 2n : 1n
  switch (kind) {
    case 'payout':
      return { execution: 150_000n + leaf, state: NEW_ACCOUNT_STATE_GAS + slots * STORAGE_SET_STATE_GAS }
    case 'export':
      return { execution: 150_000n + leaf + 400_000n + 120_000n + 2n * leaf, state: NEW_ACCOUNT_STATE_GAS + (slots + 3n + 2n * slots) * STORAGE_SET_STATE_GAS }
    case 'claim':
      return { execution: 150_000n + leaf, state: slots * STORAGE_SET_STATE_GAS }
    case 'round':
      return { execution: 550_000n + 4n * (120_000n + 2n * leaf), state: (3n + 8n * slots) * STORAGE_SET_STATE_GAS }
    case 'batch':
      return { execution: 120_000n, state: 2n * STORAGE_SET_STATE_GAS }
  }
}

export function spendTx(o: { chainId: bigint; r: Registry; slot: bigint; root: bigint; words: bigint[]; verifyExecution?: bigint }): FrameTx {
  const how = o.words[5]
  return {
    chainId: o.chainId,
    nonceKeys: [o.words[0]],
    nonceSeq: 0n,
    sender: o.r.address,
    frames: [
      recentRootFrame(o.r.sourceId, o.slot, o.root),
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, execution: o.verifyExecution ?? 300_000n, state: STORAGE_SET_STATE_GAS }),
      senderFrame({ target: o.r.address, data: ppt(o.root, 1n, o.words), ...senderGas(o.r, how === How.PAYOUT ? 'payout' : 'export') }),
    ],
    signatures: [],
    fees: FEES,
    blobVersionedHashes: [],
  }
}

export function roundTx(o: { chainId: bigint; r: Registry; slot: bigint; root: bigint; words: bigint[] }): FrameTx {
  return {
    chainId: o.chainId,
    nonceKeys: o.words.slice(0, 4),
    nonceSeq: 0n,
    sender: o.r.address,
    frames: [
      recentRootFrame(o.r.sourceId, o.slot, o.root),
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, execution: 400_000n, state: 4n * STORAGE_SET_STATE_GAS }),
      senderFrame({ target: o.r.address, data: ppt(o.root, 3n, o.words), ...senderGas(o.r, 'round') }),
    ],
    signatures: [],
    fees: FEES,
    blobVersionedHashes: [],
  }
}

export function claimTx(o: { chainId: bigint; r: Registry; words: bigint[] }): FrameTx {
  return {
    chainId: o.chainId,
    nonceKeys: [o.words[0]],
    nonceSeq: 0n,
    sender: o.r.address,
    frames: [
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, execution: 300_000n, state: STORAGE_SET_STATE_GAS }),
      senderFrame({ target: o.r.address, data: ppt(0n, 2n, o.words), ...senderGas(o.r, 'claim') }),
    ],
    signatures: [],
    fees: FEES,
    blobVersionedHashes: [],
  }
}

export const BATCH_KEY = 1n << 255n
export function batchTx(o: { chainId: bigint; r: Registry; words: bigint[] }): FrameTx {
  return {
    chainId: o.chainId,
    nonceKeys: [BATCH_KEY | o.words[0]],
    nonceSeq: 0n,
    sender: o.r.address,
    frames: [
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, execution: 400_000n, state: STORAGE_SET_STATE_GAS }),
      senderFrame({ target: o.r.address, data: encodeFunctionData({ abi: registryAbi, functionName: 'advanceRoot', args: [o.words] }), ...senderGas(o.r, 'batch') }),
    ],
    signatures: [],
    fees: FEES,
    blobVersionedHashes: [],
  }
}

/** A deposit of ether, as a SENDER frame of the funder's transaction. */
export function depositFrame(r: Registry, inner: bigint, value: bigint): Frame {
  return senderFrame({
    target: r.address,
    value,
    data: encodeFunctionData({ abi: registryAbi, functionName: 'deposit', args: [word(inner)] }),
    execution: r.mode === MODE.TREE ? 1_400_000n : 200_000n,
    state: r.mode === MODE.TREE ? 2_600_000n : 3n * STORAGE_SET_STATE_GAS,
  })
}

export const callFrame = (target: Address, data: Hex, value = 0n, execution = 200_000n, state = 2n * STORAGE_SET_STATE_GAS): Frame =>
  senderFrame({ target, data, value, execution, state })

export { word }
