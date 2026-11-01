// Experiment 17 (X12): the contracts, the keys, the digest the packer signs, and the Board's
// blob-carrying frame transaction. Addresses come from CREATE2 with label salts, and every key from
// PRIVATE_KEY and a label, so every script sees the same contracts and parties.
import { type Address, type Hex, bytesToHex, concatHex, encodeAbiParameters, encodeFunctionData, hexToBigInt, keccak256, numberToHex, pad, parseAbi, toHex } from 'viem'
import { privateKeyToAddress, sign } from 'viem/accounts'
import { compileSolidity, compileYul } from '../../src/exp-frames/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/exp-frames/deploy.js'
import { Approve, type FrameTx, type FrameTxFees, STORAGE_SET_STATE_GAS, senderFrame, verifyFrame } from '../../src/exp-frames/frametx/index.js'

export const DIR = 'experiments/17-x12-ciphertexts-in-blobs'
const word = (x: bigint | number | string) => numberToHex(BigInt(x), { size: 32 })

/** Which deployment: every salt and every key carries it, so a stopped pass reruns on fresh ones. */
export const DEPLOYMENT = process.env.X12_DEPLOYMENT ?? 'd1'
const tag = (l: string) => `exp-e2e-frames/17/${DEPLOYMENT}/${l}`

/** Base fee and blob base fee sit at a few wei on the testnet. As experiments 15 and 16. */
export const FEES: FrameTxFees = { maxPriorityFeePerGas: 1n, maxFeePerGas: 100n, maxFeePerBlobGas: 100n }
/** Covers a post's maximum cost at FEES; the Board checks it against txparam 0x06. */
export const POST_FEE = 10n ** 9n
/** An archiver's bond, a challenge's fee, and the blocks an archiver has to answer. */
export const BOND = 10n ** 15n
export const CHALLENGE_FEE = 10n ** 12n
export const WINDOW = 5n

// ---- keys ----

/** A private key from PRIVATE_KEY and a label. Never printed, never recorded. */
export const keyOf = (base: Hex, l: string): Hex => keccak256(concatHex([base, toHex(tag(`key/${l}`))]))
export const addressOf = (base: Hex, l: string): Address => privateKeyToAddress(keyOf(base, l))
/** Seeds for our recipients, from PRIVATE_KEY: also never recorded. */
export const seedOf = (base: Hex, l: string, bytes: number): Uint8Array => {
  const out = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i += 32) out.set(Buffer.from(keyOf(base, `${l}/${i / 32}`).slice(2), 'hex').subarray(0, Math.min(32, bytes - i)), i)
  return out
}

// ---- contracts ----

const boardCode = compileYul(`${DIR}/contracts/Board.yul`)
const announcer = compileSolidity(`${DIR}/contracts/Announcer.sol`, 'Announcer')
const archive = compileSolidity(`${DIR}/contracts/Archive.sol`, 'Archive')
export const announcerAbi = announcer.abi
export const archiveAbi = archive.abi

function at(l: string, initcode: Hex) {
  const salt = saltOf(tag(l))
  const code = initcode.toLowerCase() as Hex
  return { label: l, initcode: code, salt, address: create2Address(code, salt), deploy: deployFrame(code, salt).frame }
}
export function contractsOf(base: Hex) {
  const packer = addressOf(base, 'packer')
  const ann = at('announcer', announcer.bytecode)
  const board = at('board', concatHex([boardCode, pad(packer), saltOf(tag('board/word'))]))
  const arch = at('archive', concatHex([archive.bytecode, encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [board.address, BOND, CHALLENGE_FEE, WINDOW])]))
  return { packer, announcer: ann, board, archive: arch }
}

export const boardAbi = parseAbi([
  'function record(uint256[] w)',
  'function prove(uint256 seq, uint256 index, bytes32 k0, bytes32 k1, bytes32 k2, bytes entry)',
  'function posts(uint256 seq) view returns (bytes32 versionedHash, uint256 header)',
  'function count() view returns (uint256)',
  'function deposit() view returns (uint256)',
  'function packer() view returns (address)',
  'event Posted(uint256 indexed seq, bytes32 indexed versionedHash, uint256 header)',
  'event Included(uint256 indexed seq, uint256 indexed index, bytes32 entryHash)',
])

// ---- a post ----

export const POST_TAG = keccak256(toHex('exp-e2e-frames/17/post'))
export const postDigest = (chainId: bigint, board: Address, vh: Hex, header: bigint, fee: bigint) =>
  keccak256(concatHex([POST_TAG, word(chainId), pad(board), vh, word(header), word(fee)]))

/** commitment(48) || proof(48) as three words. */
export const kzgWords = (commitment: Uint8Array, proof: Uint8Array): [Hex, Hex, Hex] => {
  const b = bytesToHex(new Uint8Array([...commitment, ...proof]))
  return [`0x${b.slice(2, 66)}`, `0x${b.slice(66, 130)}`, `0x${b.slice(130, 194)}`]
}

/** record(w): header, fee, commitment || proof, then the packer's r, s, v over the digest. */
export async function postWords(packerKey: Hex, chainId: bigint, board: Address, vh: Hex, header: bigint, fee: bigint, commitment: Uint8Array, proof: Uint8Array) {
  const sig = await sign({ hash: postDigest(chainId, board, vh, header, fee), privateKey: packerKey })
  return [header, fee, ...kzgWords(commitment, proof).map((x) => hexToBigInt(x)), hexToBigInt(sig.r), hexToBigInt(sig.s), sig.v!]
}

/** The nonce key of a blob: keccak256(versioned hash), as the Board's key() requires. */
export const postKey = (vh: Hex) => hexToBigInt(keccak256(vh))

export const VERIFY_LIMIT = 100_000n
// record() writes up to four fresh slots: with state for three, the shortfall spilled into
// execution and exhausted it (passes d2 and d3). With four it used 61,045 execution gas.
export const SENDER_GAS = { execution: 100_000n, state: 4n * STORAGE_SET_STATE_GAS }

/** The Board as sender and payer: VERIFY, then record(w), carrying `blobs` (normally one). */
export function postTx(chainId: bigint, board: Address, w: bigint[], blobs: Hex[], key: bigint): FrameTx {
  return {
    chainId,
    nonceKeys: [key],
    nonceSeq: 0n,
    sender: board,
    frames: [
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, execution: VERIFY_LIMIT, state: STORAGE_SET_STATE_GAS }),
      senderFrame({ target: board, data: encodeFunctionData({ abi: boardAbi, functionName: 'record', args: [w] }), ...SENDER_GAS }),
    ],
    signatures: [],
    fees: FEES,
    blobVersionedHashes: blobs,
  }
}

/**
 * The testnet's RPC sits behind a balancer whose nodes can lag one another, so a read just after
 * a transaction can reach a node that has not seen it. Retry until `f` answers, for a while. As
 * experiments 15 and 16.
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
