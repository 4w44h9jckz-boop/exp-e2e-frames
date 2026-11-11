// Experiment 28: the typed data the device signs, one file per vector, from exp-frames experiment
// 27's published vector sets. Each file is checked against the vector's own E before it is
// written, so the device is only ever asked to sign exactly E.
//
// Usage: npx tsx typed-data.ts <vectors.json> <set label> <out dir>
//
// The layout is the draft ERC's: domain FrameExecution/1/chainId/verifyingContract = sender;
// message FrameExecution(nonceKeysHash, nonceSeq, Frame[] frames, bytes32[] blobVersionedHashes);
// a pay frame (VERIFY with PAYMENT scope alone) has its target, limits and data zeroed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { type Address, type Hex, concatHex, hashTypedData, keccak256, numberToHex, zeroAddress } from 'viem'

type Frame = { mode: number; flags: number; target: Address | null; executionLimit: number; stateLimit: number; value: string; data: Hex }
type Tx = { chainId: number; sender: Address; nonceKeys: (number | string)[]; nonceSeq: number; frames: Frame[]; blobVersionedHashes: Hex[] }

const types = {
  FrameExecution: [
    { name: 'nonceKeysHash', type: 'bytes32' },
    { name: 'nonceSeq', type: 'uint64' },
    { name: 'frames', type: 'Frame[]' },
    { name: 'blobVersionedHashes', type: 'bytes32[]' },
  ],
  Frame: [
    { name: 'mode', type: 'uint8' },
    { name: 'flags', type: 'uint8' },
    { name: 'target', type: 'address' },
    { name: 'executionLimit', type: 'uint64' },
    { name: 'stateLimit', type: 'uint64' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
  ],
} as const

const word = (n: bigint) => numberToHex(n, { size: 32 })
const isPay = (f: Frame) => f.mode === 1 && (f.flags & 3) === 1

export function typedData(tx: Tx) {
  const keys = tx.nonceKeys.map((k) => BigInt(k))
  const frames = tx.frames.map((f) => {
    const pay = isPay(f)
    return {
      mode: f.mode,
      flags: f.flags,
      target: pay ? zeroAddress : (f.target ?? tx.sender),
      executionLimit: pay ? 0 : f.executionLimit,
      stateLimit: pay ? 0 : f.stateLimit,
      value: BigInt(f.value),
      data: pay ? '0x' : f.data,
    }
  })
  return {
    domain: { name: 'FrameExecution', version: '1', chainId: tx.chainId, verifyingContract: tx.sender },
    types,
    primaryType: 'FrameExecution' as const,
    message: {
      nonceKeysHash: keccak256(concatHex([word(BigInt(keys.length)), ...keys.map(word)])),
      nonceSeq: BigInt(tx.nonceSeq),
      frames,
      blobVersionedHashes: tx.blobVersionedHashes,
    },
  }
}

// The JSON the device's host library takes: EIP712Domain spelled out, numbers as decimal strings.
function forDevice(td: ReturnType<typeof typedData>) {
  const big = (v: unknown): unknown =>
    typeof v === 'bigint' ? v.toString() : Array.isArray(v) ? v.map(big) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, big(x)])) : v
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      ...td.types,
    },
    primaryType: td.primaryType,
    domain: td.domain,
    message: big(td.message),
  }
}

const [file, label, out] = process.argv.slice(2)
const set = JSON.parse(readFileSync(file, 'utf8'))
mkdirSync(`${out}/${label}`, { recursive: true })
let n = 0
for (const c of set.cases) {
  const td = typedData(c.tx)
  const e = hashTypedData(td as never)
  if (e.toLowerCase() !== c.executionDigest.toLowerCase()) throw new Error(`${label}/${c.name}: computed ${e}, vector says ${c.executionDigest}`)
  writeFileSync(`${out}/${label}/${c.name}.json`, `${JSON.stringify({ name: c.name, set: label, eip8250: set.eip8250, executionDigest: c.executionDigest, typedData: forDevice(td) }, null, 1)}\n`)
  n++
}
console.log(`${label}: ${n} vectors, every one equal to its E`)
