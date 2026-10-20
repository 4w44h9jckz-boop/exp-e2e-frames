import { RPC_URL } from './env.js'

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

/** One JSON-RPC call; throws on an error response. */
export async function rpc(method: string, params: unknown[], url = RPC_URL): Promise<Json> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = await res.json()
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`)
  return body.result
}

export const hexToNumber = (x: string): number => Number.parseInt(x, 16)

/** What a run records about a mined frame transaction, read from the chain. */
export async function chainFacts(hash: string, url = RPC_URL) {
  const [tx, receipt] = await Promise.all([
    rpc('eth_getTransactionByHash', [hash], url),
    rpc('eth_getTransactionReceipt', [hash], url),
  ])
  if (!receipt) return { hash, mined: false, known: Boolean(tx) }
  return {
    hash,
    mined: true,
    block: hexToNumber(receipt.blockNumber),
    blockHash: receipt.blockHash as string,
    status: receipt.status as string,
    sender: (tx.sender ?? tx.from) as string,
    payer: receipt.payer as string,
    signatures: (tx.signatures ?? []).length as number,
    frames: (tx.frames ?? []).length as number,
    frameStatuses: (receipt.frameReceipts ?? []).map((f: Json) => f.status as string),
    gasUsed: hexToNumber(receipt.gasUsed),
  }
}
