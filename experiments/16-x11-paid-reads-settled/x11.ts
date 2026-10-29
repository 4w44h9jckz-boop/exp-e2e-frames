// Experiment 16 (X11): the pool, the keys, batch roots, the digests members sign, and the frame
// transactions. Addresses come from CREATE2 with label salts, and every key from PRIVATE_KEY and a
// label, so every script sees the same contracts and parties.
import { type Address, type Hex, concatHex, encodeFunctionData, getAddress, hexToBigInt, keccak256, numberToHex, pad, parseAbi, parseAbiItem, toHex } from 'viem'
import { privateKeyToAddress, sign } from 'viem/accounts'
import { compileYul } from '../../src/exp-frames/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/exp-frames/deploy.js'
import { Approve, type FrameTx, type FrameTxFees, NEW_ACCOUNT_STATE_GAS, STORAGE_SET_STATE_GAS, senderFrame, verifyFrame } from '../../src/exp-frames/frametx/index.js'

export const DIR = 'experiments/16-x11-paid-reads-settled'
const word = (x: bigint | number | string) => numberToHex(BigInt(x), { size: 32 })

/** Which deployment: every salt and every key carries it, so a stopped pass reruns on fresh ones. */
export const DEPLOYMENT = process.env.X11_DEPLOYMENT ?? 'd1'
const tag = (l: string) => `exp-e2e-frames/16/${DEPLOYMENT}/${l}`

/** Base fee sits at 7 wei on the testnet; a 1 wei tip is enough. As experiment 15. */
export const FEES: FrameTxFees = { maxPriorityFeePerGas: 1n, maxFeePerGas: 100n, maxFeePerBlobGas: 0n }
/** A ticket's price, a member's bond, what one slash takes, and the fee each payment leaves. */
export const PRICE = 10n ** 12n
export const SLASH = 10n ** 15n
export const BOND = 2n * SLASH
/** Covers a transaction's maximum cost at FEES (under 10^6 gas at 100 wei); ReadPool checks it. */
export const FEE = 10n ** 9n
/** Blocks in an epoch: about three minutes on the testnet. */
export const EPOCH = 30n
export const epochOf = (block: bigint) => block / EPOCH
export const epochEnd = (epoch: bigint) => (epoch + 1n) * EPOCH - 1n

// ---- keys ----

/** A private key from PRIVATE_KEY and a label. Never printed, never recorded. */
export const keyOf = (base: Hex, l: string): Hex => keccak256(concatHex([base, toHex(tag(`key/${l}`))]))
export const addressOf = (base: Hex, l: string): Address => privateKeyToAddress(keyOf(base, l))
export const MEMBERS = 4
export const QUORUM = 3

// ---- the pool ----

const poolCode = compileYul(`${DIR}/contracts/ReadPool.yul`)
export function poolOf(base: Hex) {
  const members = [0, 1, 2, 3].map((i) => addressOf(base, `member/${i}`))
  const salt = saltOf(tag('pool'))
  const initcode = concatHex([poolCode, word(PRICE), ...members.map((m) => pad(m)), word(SLASH), salt]).toLowerCase() as Hex
  const address = create2Address(initcode, salt)
  return { label: 'pool', initcode, salt, address, members, deploy: deployFrame(initcode, salt).frame }
}
export type Pool = ReturnType<typeof poolOf>

export const poolAbi = parseAbi([
  'function buy(uint256 n) payable',
  'function bond(uint256 i) payable',
  'function settle(uint256[] w)',
  'function refund(uint256[] w)',
  'function slash(uint256[] w)',
  'function price() view returns (uint256)',
  'function sold() view returns (uint256)',
  'function paid() view returns (uint256)',
  'function refunded() view returns (uint256)',
  'function bondOf(uint256 i) view returns (uint256)',
  'function member(uint256 i) view returns (address)',
  'function slashAmount() view returns (uint256)',
])
export const EVENTS = {
  bought: parseAbiItem('event Bought(address indexed buyer, uint256 n)'),
  settled: parseAbiItem('event Settled(address indexed server, uint256 epoch, uint256 n, bytes32 root)'),
  refunded: parseAbiItem('event RefundPaid(bytes32 indexed serial, address recipient)'),
  slashed: parseAbiItem('event Slashed(uint256 indexed member, address reporter, uint256 kind)'),
}

// ---- batches ----

export const SETTLE_TAG = keccak256(toHex('exp-e2e-frames/16/settle'))
export const REFUND_TAG = keccak256(toHex('exp-e2e-frames/16/refund'))

/** The depth of a batch of n serials: the least d with 2^d >= n. */
export const depthOf = (n: number) => {
  let d = 0
  while (1 << d < n) d++
  return d
}
const node = (a: Hex, b: Hex) => keccak256(concatHex([a, b]))
const ZERO = word(0)

/** Every level of the batch's tree: leaves keccak256(serial), padded with zero leaves to 2^d. */
function levels(serials: Hex[]): Hex[][] {
  const d = depthOf(serials.length)
  let level: Hex[] = serials.map((s) => keccak256(s))
  while (level.length < 1 << d) level.push(ZERO)
  const out = [level]
  while (level.length > 1) {
    const next: Hex[] = []
    for (let i = 0; i < level.length; i += 2) next.push(node(level[i], level[i + 1]))
    level = next
    out.push(level)
  }
  return out
}
export const rootOf = (serials: Hex[]): Hex => levels(serials).at(-1)![0]
/** The serial at `index`'s path, eight words: the siblings from the leaf up, zeros after. */
export function pathOf(serials: Hex[], index: number): Hex[] {
  const ls = levels(serials)
  const path: Hex[] = []
  for (let l = 0; l < ls.length - 1; l++) path.push(ls[l][(index >> l) ^ 1])
  while (path.length < 8) path.push(ZERO)
  return path
}

export type Batch = { server: Address; epoch: bigint; serials: Hex[] }
export const settleDigest = (chainId: bigint, pool: Address, server: Address, epoch: bigint, n: bigint, root: Hex): Hex =>
  keccak256(concatHex([SETTLE_TAG, word(chainId), pad(pool), pad(server), word(epoch), word(n), root]))
export const batchDigest = (chainId: bigint, pool: Address, b: Batch) => settleDigest(chainId, pool, b.server, b.epoch, BigInt(b.serials.length), rootOf(b.serials))
export const refundDigest = (chainId: bigint, pool: Address, serial: Hex, recipient: Address): Hex =>
  keccak256(concatHex([REFUND_TAG, word(chainId), pad(pool), serial, pad(recipient)]))

/** A member's signature over a digest: (r, s, v), low s, as ReadPool's `signedBy` reads it. */
export type Sig = { member: number; r: Hex; s: Hex; v: bigint }
export async function signDigest(privateKey: Hex, member: number, digest: Hex): Promise<Sig> {
  const sig = await sign({ hash: digest, privateKey })
  return { member, r: sig.r, s: sig.s, v: sig.v ?? (sig.yParity ? 28n : 27n) }
}
const sigWords = (s: Sig) => [BigInt(s.member), hexToBigInt(s.r), hexToBigInt(s.s), s.v]

// ---- the words each transaction carries ----

export function settleWords(b: Batch, sigs: Sig[], fee = FEE): bigint[] {
  return [hexToBigInt(b.server), b.epoch, BigInt(b.serials.length), hexToBigInt(rootOf(b.serials)), fee, ...sigs.flatMap(sigWords)]
}
export function refundWords(serial: Hex, recipient: Address, sigs: Sig[], fee = FEE): bigint[] {
  return [hexToBigInt(serial), hexToBigInt(recipient), fee, ...sigs.flatMap(sigWords)]
}
const batchWordsOf = (b: Batch, s: Sig) => [hexToBigInt(b.server), b.epoch, BigInt(b.serials.length), hexToBigInt(rootOf(b.serials)), hexToBigInt(s.r), hexToBigInt(s.s), s.v]
/** Kind 1: one serial in two batches, both signed by `member`. */
export function slashTwoBatches(o: { member: number; reporter: Address; a: Batch; sigA: Sig; b: Batch; sigB: Sig; serial: Hex }, fee = FEE): bigint[] {
  const ia = o.a.serials.indexOf(o.serial)
  const ib = o.b.serials.indexOf(o.serial)
  const pa = ia < 0 ? Array(8).fill(ZERO) : pathOf(o.a.serials, ia)
  const pb = ib < 0 ? Array(8).fill(ZERO) : pathOf(o.b.serials, ib)
  return [BigInt(o.member), hexToBigInt(o.reporter), fee, 1n, ...batchWordsOf(o.a, o.sigA), ...batchWordsOf(o.b, o.sigB), hexToBigInt(o.serial), BigInt(Math.max(ia, 0)), BigInt(Math.max(ib, 0)), ...pa.map((h) => hexToBigInt(h)), ...pb.map((h) => hexToBigInt(h))]
}
/** Kind 2: one serial in a batch and in a refund, both signed by `member`. */
export function slashBatchAndRefund(o: { member: number; reporter: Address; a: Batch; sigA: Sig; serial: Hex; recipient: Address; sigR: Sig }, fee = FEE): bigint[] {
  const ia = o.a.serials.indexOf(o.serial)
  const pa = ia < 0 ? Array(8).fill(ZERO) : pathOf(o.a.serials, ia)
  return [BigInt(o.member), hexToBigInt(o.reporter), fee, 2n, ...batchWordsOf(o.a, o.sigA), hexToBigInt(o.serial), hexToBigInt(o.recipient), hexToBigInt(o.sigR.r), hexToBigInt(o.sigR.s), o.sigR.v, BigInt(Math.max(ia, 0)), ...pa.map((h) => hexToBigInt(h))]
}

/** The one nonce key of each transaction, as ReadPool's `key(kind, x, y)` computes it. */
export const keyFor = (kind: 1n | 2n | 3n, x: bigint, y: bigint) => hexToBigInt(keccak256(concatHex([word(kind), word(x), word(y)])))
const pairOf = (x: Hex, y: Hex) => hexToBigInt(keccak256(concatHex([x, y])))
export function slashKey(chainId: bigint, pool: Address, w: bigint[]): bigint {
  const a = settleDigest(chainId, pool, getAddress(numberToHex(w[4], { size: 20 })), w[5], w[6], word(w[7]))
  if (w[3] === 1n) {
    const b = settleDigest(chainId, pool, getAddress(numberToHex(w[11], { size: 20 })), w[12], w[13], word(w[14]))
    return keyFor(3n, w[0], hexToBigInt(a) < hexToBigInt(b) ? pairOf(a, b) : pairOf(b, a))
  }
  const r = refundDigest(chainId, pool, word(w[11]), getAddress(numberToHex(w[12], { size: 20 })))
  return keyFor(3n, w[0], pairOf(a, r))
}

// ---- frame transactions: the pool is sender and payer ----

/** The SENDER frame's gas: ReadPool's floors, 80,000 and a fresh account plus two fresh slots. */
const SENDER_GAS = { execution: 120_000n, state: NEW_ACCOUNT_STATE_GAS + 2n * STORAGE_SET_STATE_GAS }
/** EIP-8141's MAX_VERIFY_GAS: the VERIFY frame is given no more, so a mined one fits it. */
export const VERIFY_LIMIT = 100_000n

function poolTx(chainId: bigint, pool: Pool, key: bigint, fn: 'settle' | 'refund' | 'slash', w: bigint[]): FrameTx {
  return {
    chainId,
    nonceKeys: [key],
    nonceSeq: 0n,
    sender: pool.address,
    frames: [
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, execution: VERIFY_LIMIT, state: STORAGE_SET_STATE_GAS }),
      senderFrame({ target: pool.address, data: encodeFunctionData({ abi: poolAbi, functionName: fn, args: [w] }), ...SENDER_GAS }),
    ],
    signatures: [],
    fees: FEES,
    blobVersionedHashes: [],
  }
}
export const settleTx = (chainId: bigint, pool: Pool, w: bigint[]) => poolTx(chainId, pool, keyFor(1n, w[0], w[1]), 'settle', w)
export const refundTx = (chainId: bigint, pool: Pool, w: bigint[]) => poolTx(chainId, pool, keyFor(2n, w[0], 0n), 'refund', w)
export const slashTx = (chainId: bigint, pool: Pool, w: bigint[]) => poolTx(chainId, pool, slashKey(chainId, pool.address, w), 'slash', w)

/**
 * The testnet's RPC sits behind a balancer whose nodes can lag one another, so a read just after
 * a transaction can reach a node that has not seen it. Retry until `f` answers, for a while. As
 * experiment 15.
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

export { word }
