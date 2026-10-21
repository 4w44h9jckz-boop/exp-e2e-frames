import { join } from 'node:path'
import { type Hex, concatHex, encodeAbiParameters, keccak256 } from 'viem'
import { RPC_URL } from './env.js'
import { rpc } from './rpc.js'
import { run } from './sh.js'

/** The committees' Rust workspace: each crate a library with a command line. */
export const COMMITTEE_DIR = new URL('../../committee/', import.meta.url).pathname

/** Builds one of the committees' command lines, release profile, and returns its path. */
export async function buildCommittee(pkg: string): Promise<string> {
  await run('cargo', ['build', '--release', '-p', pkg], { cwd: COMMITTEE_DIR })
  return join(COMMITTEE_DIR, 'target', 'release', pkg)
}

/**
 * The verifier X1's pool calls in its `VERIFY` frame: Tornado Cash's Groth16 verifier with its
 * pairing check patched for the testnet, deployed by exp-frames experiment 06 and read from the
 * refund pool's code (its word at offset 128 of the trailing constants).
 */
export const PATCHED_VERIFIER: Hex = '0x87a7C1f76b03dA00de489897d436BbEDDd2133b7'
export const REFUND_POOL: Hex = '0xe19605853A749322655470199Fd31D3F3e53Baf9'

/** Calldata for Tornado's `verifyProof(bytes proof, uint256[6] input)`. */
export function verifyProofCalldata(proof: Hex, inputs: (string | bigint)[]): Hex {
  const args = encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'uint256[6]' }],
    [proof, inputs.map(BigInt) as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint]],
  )
  return concatHex(['0x695ef6f9', args])
}

/** Asks the chain's verifier, by `eth_call` at `block`, whether it accepts `proof` for `inputs`. */
export async function verifierAccepts(proof: Hex, inputs: (string | bigint)[], block: Hex, verifier = PATCHED_VERIFIER, url = RPC_URL) {
  const out: Hex = await rpc('eth_call', [{ to: verifier, data: verifyProofCalldata(proof, inputs) }, block], url)
  return BigInt(out) === 1n
}

/** The verifier's code, and its hash, at `block`. */
export async function codeAt(address: Hex, block: Hex, url = RPC_URL) {
  const code: Hex = await rpc('eth_getCode', [address, block], url)
  return { code, codeHash: keccak256(code) }
}
