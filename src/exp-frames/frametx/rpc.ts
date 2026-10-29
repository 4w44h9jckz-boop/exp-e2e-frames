import {
  type Address,
  type Hex,
  type PublicClient,
  createPublicClient,
  defineChain,
  encodeAbiParameters,
  getAddress,
  hexToBigInt,
  keccak256,
  http,
} from 'viem'
import { NONCE_MANAGER } from './constants.js'
import { frameTxHash, serializeFrameTx } from './encode.js'
import type { FrameGasUsed } from './gas.js'
import type { Frame, FrameSignature, FrameTx, FrameTxEnvelope, FrameTxFees } from './types.js'

export const HEGOTA_RPC_URL = 'https://rpc1.privacy.ethrex.xyz'
export const HEGOTA_FAUCET_URL = 'https://faucet.privacy.ethrex.xyz'
export const HEGOTA_EXPLORER_URL = 'https://dora.privacy.ethrex.xyz'

export const hegotaTestnet = defineChain({
  id: 8141,
  name: 'ethrex Hegotá testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [HEGOTA_RPC_URL] } },
  blockExplorers: { default: { name: 'Dora', url: HEGOTA_EXPLORER_URL } },
  testnet: true,
})

/**
 * ethpandaops frames-devnet-0: geth, Nethermind, reth and ethrex behind one eRPC balancer, which
 * sends each request (a whole batch at a time) to one of them. EIP-8141 at the same pin as the
 * Hegota testnet, without EIP-8250 or EIP-8272, so its envelope is `plain`. ethpandaops renamed
 * its hostnames to bogota-devnet-0 on 2026-10-12 (ethpandaops/frames-devnets `7c889ab`); the chain
 * and its id are unchanged, and the old hostnames answer 404.
 */
export const FRAMES_DEVNET_0_RPC_URL = 'https://rpc.bogota-devnet-0.ethpandaops.io'
export const FRAMES_DEVNET_0_EXPLORER_URL = 'https://dora.bogota-devnet-0.ethpandaops.io'

export const framesDevnet0 = defineChain({
  id: 7_034_189_865,
  name: 'ethpandaops frames-devnet-0',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [FRAMES_DEVNET_0_RPC_URL] } },
  blockExplorers: { default: { name: 'Dora', url: FRAMES_DEVNET_0_EXPLORER_URL } },
  testnet: true,
})

/** The envelope a chain takes: `plain` on frames-devnet-0, `keyed` everywhere else so far. */
export function envelopeFor(chainId: bigint | number): FrameTxEnvelope {
  return BigInt(chainId) === BigInt(framesDevnet0.id) ? 'plain' : 'keyed'
}

/**
 * `RPC_URL` selects the network; the Hegota testnet is the default. On frames-devnet-0,
 * `upstream` (or `RPC_UPSTREAM`), such as `geth`, pins every request to that client and skips the
 * balancer's cache, through eRPC's `X-ERPC-Use-Upstream` and `X-ERPC-Skip-Cache-Read`
 * directives.
 *
 * The directives do not survive eRPC's multiplexer: identical requests in flight at the same time
 * are merged and all answered by whichever upstream served the first, whatever each one asked
 * for. So a pinned client checks the `x-erpc-upstream` response header, which names the node that
 * answered, and throws `UpstreamMismatch` rather than return another client's answer as this
 * one's. viem retries the request, later and alone, so it usually reaches the right client in
 * the end; asking different clients the same question one at a time avoids the retries.
 */
export function makeClient(
  rpcUrl = process.env.RPC_URL || HEGOTA_RPC_URL,
  upstream = process.env.RPC_UPSTREAM,
): PublicClient {
  const chain = rpcUrl === FRAMES_DEVNET_0_RPC_URL ? framesDevnet0 : hegotaTestnet
  if (!upstream) return createPublicClient({ chain, transport: http(rpcUrl) })
  const headers = { 'X-ERPC-Use-Upstream': `*${upstream}*`, 'X-ERPC-Skip-Cache-Read': 'true' }
  const onFetchResponse = (response: Response) => {
    const answered = response.headers.get('x-erpc-upstream')
    if (answered && !answered.includes(upstream)) throw new UpstreamMismatch(upstream, answered)
  }
  return createPublicClient({ chain, transport: http(rpcUrl, { fetchOptions: { headers }, onFetchResponse }) })
}

export class UpstreamMismatch extends Error {
  constructor(
    readonly asked: string,
    readonly answered: string,
  ) {
    super(`asked ${asked}, answered by ${answered.replace(/#.*/, '')}`)
  }
}

/** Untyped JSON-RPC call, for methods viem does not know (or would reformat). */
export async function rpc<T>(client: PublicClient, method: string, params: unknown[]): Promise<T> {
  const request = client.request as unknown as (args: { method: string; params: unknown[] }) => Promise<T>
  return request({ method, params })
}

// ---- JSON shapes served by ethrex, and how the other clients differ ----

/**
 * A frame receipt. The clients do not agree on its JSON yet (execution-apis#860 is open):
 * frames-devnet-0 on 2026-10-08 served execution gas as `gasUsed` (ethrex), `executionGasUsed`
 * (Nethermind) or both (geth, reth), and `status` as a number (Nethermind) or a quantity (the
 * rest). Read them with `frameReceiptGas` and `frameReceiptStatus`.
 */
export type FrameReceiptJson = {
  status: Hex | number
  gasUsed?: Hex
  executionGasUsed?: Hex
  stateGasUsed: Hex
  logs: { address: Address; topics: Hex[]; data: Hex }[]
}

export function frameReceiptGas(f: FrameReceiptJson): FrameGasUsed {
  const execution = f.executionGasUsed ?? f.gasUsed
  if (execution === undefined) throw new Error('frame receipt has neither gasUsed nor executionGasUsed')
  return { execution: hexToBigInt(execution), state: hexToBigInt(f.stateGasUsed) }
}

/** 0 FAILURE, 1 SUCCESS, 2 SKIPPED. */
export function frameReceiptStatus(f: FrameReceiptJson): number {
  return typeof f.status === 'number' ? f.status : Number(hexToBigInt(f.status))
}

export type FrameTxReceiptJson = {
  transactionHash: Hex
  blockHash: Hex
  blockNumber: Hex
  transactionIndex: Hex
  type: Hex
  status: Hex
  from: Address
  payer: Address
  gasUsed: Hex
  cumulativeGasUsed: Hex
  effectiveGasPrice: Hex
  frameReceipts: FrameReceiptJson[]
  logs: unknown[]
}

/**
 * A frame as the node serves it. On frames-devnet-0 (2026-10-08) each client named the fields
 * its own way; execution-apis#907 would fix one:
 * - ethrex: `to` (null when null), `gasLimit`, `stateGasLimit`;
 * - Nethermind: `target` (absent when null), `executionGasLimit`, `stateGasLimit`;
 * - reth and geth: `target` (absent when null), `executionGas`, `stateGas`.
 * A signature entry's null `signer` is `null` (ethrex), absent (Nethermind, reth) or `0x` (geth).
 */
export type FrameJson = {
  mode: Hex
  flags: Hex
  to?: Address | null
  target?: Address | null
  gasLimit?: Hex
  executionGasLimit?: Hex
  executionGas?: Hex
  stateGasLimit?: Hex
  stateGas?: Hex
  value: Hex
  data: Hex
}

export type FrameTxJson = {
  hash: Hex
  type: Hex
  chainId: Hex
  /** Keyed envelope (EIP-8250). */
  nonceKeys?: Hex[]
  nonceSeq?: Hex
  /** Plain envelope (frames-devnet-0). */
  nonce?: Hex
  /** Nethermind serves no `sender` (frames-devnet-0, 2026-10-08); `from` is the same address. */
  sender?: Address
  from?: Address
  frames: FrameJson[]
  signatures: { scheme: Hex; signer?: Address | null; msg: Hex; signature: Hex }[]
  maxPriorityFeePerGas: Hex
  maxFeePerGas: Hex
  maxFeePerBlobGas: Hex
  /** geth leaves it out when empty. */
  blobVersionedHashes?: Hex[]
  blockNumber: Hex | null
}

export type SimulateResult = {
  /** All frame-specific admission gates passed (necessary, not sufficient, for mempool admission). */
  valid: boolean
  prefixShape: 'SelfVerify' | 'DeploySelfVerify' | 'OnlyVerifyPay' | 'DeployOnlyVerifyPay' | null
  payer: Address | null
  maxCost: Hex
  violation: string | null
  gasUsed: Hex | null
  frames: { gasUsed: Hex; succeeded: boolean }[] | null
  executionStatus: 'success' | 'reverted' | null
  executionError: string | null
}

/** An address the node may serve as `null`, absent or `0x`. */
function nullable(a: Address | null | undefined): Address | null {
  return a && a !== '0x' ? getAddress(a) : null
}

/** Rebuild a FrameTx from the node's JSON. Check `frameTxHash(tx) === json.hash` before trusting it. */
export function frameTxFromJson(j: FrameTxJson): FrameTx {
  const big = (h: Hex) => hexToBigInt(h)
  const nonce =
    j.nonceKeys !== undefined && j.nonceSeq !== undefined
      ? { nonceKeys: j.nonceKeys.map(big), nonceSeq: big(j.nonceSeq) }
      : j.nonce !== undefined
        ? { envelope: 'plain' as const, nonceKeys: [0n], nonceSeq: big(j.nonce) }
        : undefined
  if (!nonce) throw new Error(`${j.hash}: neither nonceKeys/nonceSeq nor nonce`)
  return {
    chainId: big(j.chainId),
    ...nonce,
    sender: getAddress((j.sender ?? j.from) as Address),
    frames: j.frames.map((f, i): Frame => {
      const target = nullable(f.to ?? f.target)
      const execution = f.gasLimit ?? f.executionGasLimit ?? f.executionGas
      const state = f.stateGasLimit ?? f.stateGas
      if (execution === undefined || state === undefined) throw new Error(`${j.hash}: frame ${i} has no gas limits`)
      return {
        mode: Number(big(f.mode)),
        flags: Number(big(f.flags)),
        target,
        limits: { execution: big(execution), state: big(state) },
        value: big(f.value),
        data: f.data,
      }
    }),
    signatures: j.signatures.map(
      (s): FrameSignature => ({
        scheme: Number(big(s.scheme)),
        signer: nullable(s.signer),
        msg: s.msg,
        signature: s.signature,
      }),
    ),
    fees: {
      maxPriorityFeePerGas: big(j.maxPriorityFeePerGas),
      maxFeePerGas: big(j.maxFeePerGas),
      maxFeePerBlobGas: big(j.maxFeePerBlobGas),
    },
    blobVersionedHashes: j.blobVersionedHashes ?? [],
  }
}

// ---- nonces & fees ----

/** NONCE_MANAGER storage slot for a non-zero key: keccak256(pad32(sender) || uint256(key)). */
export function keyedNonceSlot(sender: Address, key: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [sender, key]))
}

/** Current `nonce_seq` for a key set; every key must sit at the same sequence. */
export async function getNonceSeq(client: PublicClient, sender: Address, nonceKeys: bigint[] = [0n]): Promise<bigint> {
  const seqs = await Promise.all(
    nonceKeys.map(async (key) => {
      if (key === 0n) return BigInt(await client.getTransactionCount({ address: sender, blockTag: 'latest' }))
      const v = await client.getStorageAt({ address: NONCE_MANAGER, slot: keyedNonceSlot(sender, key) })
      return v ? hexToBigInt(v) : 0n
    }),
  )
  if (seqs.some((s) => s !== seqs[0])) throw new Error(`nonce keys sit at different sequences: ${seqs.join(', ')}`)
  return seqs[0]
}

/** 2 × base fee + tip, like the ethrex reference submitters. */
export async function suggestFees(client: PublicClient, tip = 1_000_000_000n): Promise<FrameTxFees> {
  const block = await client.getBlock({ blockTag: 'latest' })
  const base = block.baseFeePerGas ?? 0n
  return { maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip, maxFeePerBlobGas: 0n }
}

/** Fill chain id, nonce sequence and fees around a frame list. Signatures still need signing. */
export async function prepareFrameTx(
  client: PublicClient,
  opts: {
    sender: Address
    frames: Frame[]
    signatures: FrameSignature[]
    nonceKeys?: bigint[]
    nonceSeq?: bigint
    fees?: FrameTxFees
  },
): Promise<FrameTx> {
  const nonceKeys = opts.nonceKeys ?? [0n]
  const [chainId, nonceSeq, fees] = await Promise.all([
    client.getChainId(),
    opts.nonceSeq ?? getNonceSeq(client, opts.sender, nonceKeys),
    opts.fees ?? suggestFees(client),
  ])
  const envelope = envelopeFor(chainId)
  if (envelope === 'plain' && (nonceKeys.length !== 1 || nonceKeys[0] !== 0n)) {
    throw new Error(`chain ${chainId} has no EIP-8250 keyed nonces`)
  }
  return {
    chainId: BigInt(chainId),
    ...(envelope === 'plain' ? { envelope } : {}),
    nonceKeys,
    nonceSeq,
    sender: getAddress(opts.sender),
    frames: opts.frames,
    signatures: opts.signatures,
    fees,
    blobVersionedHashes: [],
  }
}

// ---- submit / observe ----

export async function simulateFrameTx(client: PublicClient, tx: FrameTx, block: string = 'latest'): Promise<SimulateResult> {
  return rpc<SimulateResult>(client, 'ethrex_simulateFrameTransaction', [serializeFrameTx(tx), block])
}

export async function sendFrameTx(client: PublicClient, tx: FrameTx): Promise<Hex> {
  const raw = serializeFrameTx(tx)
  const hash = await rpc<Hex>(client, 'eth_sendRawTransaction', [raw])
  const expected = frameTxHash(tx)
  if (hash.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`node returned hash ${hash}, expected keccak256(raw) = ${expected}`)
  }
  return hash
}

export async function getFrameTxReceipt(client: PublicClient, hash: Hex): Promise<FrameTxReceiptJson | null> {
  return rpc<FrameTxReceiptJson | null>(client, 'eth_getTransactionReceipt', [hash])
}

export async function getFrameTxJson(client: PublicClient, hash: Hex): Promise<FrameTxJson | null> {
  return rpc<FrameTxJson | null>(client, 'eth_getTransactionByHash', [hash])
}

export async function waitForFrameTxReceipt(
  client: PublicClient,
  hash: Hex,
  { timeoutMs = 90_000, pollMs = 2_000 } = {},
): Promise<FrameTxReceiptJson> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await getFrameTxReceipt(client, hash)
    if (r) return r
    await new Promise((res) => setTimeout(res, pollMs))
  }
  throw new Error(`no receipt for ${hash} after ${timeoutMs} ms`)
}

/** Ask the testnet faucet for 1 ETH. */
export async function claimFaucet(address: Address, faucetUrl = HEGOTA_FAUCET_URL): Promise<unknown> {
  const res = await fetch(`${faucetUrl}/api/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address }),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`faucet ${res.status}: ${body}`)
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}
