import { type Address, type Hex, type PublicClient, concatHex, getContractAddress, keccak256, size, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { execute } from './execute.js'
import {
  Approve,
  CPSB,
  CREATE2_DEPLOYER,
  type Frame,
  NEW_ACCOUNT_STATE_GAS,
  prepareFrameTx,
  secp256k1Placeholder,
  senderFrame,
  verifyFrame,
} from './frametx/index.js'

/** Deterministic salt from a label. */
export function saltOf(label: string): Hex {
  return keccak256(toHex(label))
}

/** Address the CREATE2 deployer gives `initcode` under `salt`. */
export function create2Address(initcode: Hex, salt: Hex): Address {
  return getContractAddress({ opcode: 'CREATE2', from: CREATE2_DEPLOYER, salt, bytecode: initcode })
}

/**
 * A SENDER frame deploying `initcode` through the CREATE2 deployer. The state budget covers
 * the new account plus a code deposit no larger than the initcode, plus `extraState` for
 * whatever the constructor writes (97,920 per fresh slot).
 */
export function deployFrame(initcode: Hex, salt: Hex, extraState = 0n): { frame: Frame; address: Address } {
  return {
    address: create2Address(initcode, salt),
    frame: senderFrame({
      target: CREATE2_DEPLOYER,
      data: concatHex([salt, initcode]),
      execution: 300_000n + 20n * BigInt(size(initcode)),
      state: NEW_ACCOUNT_STATE_GAS + CPSB * BigInt(size(initcode)) + extraState,
    }),
  }
}

/**
 * Send the given SENDER frames from an EOA (self-verified, Example 1 shape), unless every
 * address in `expectCode` already has code.
 */
export async function sendFrames(
  client: PublicClient,
  privateKey: Hex,
  frames: Frame[],
  { label, expectCode = [] }: { label: string; expectCode?: Address[] },
) {
  if (expectCode.length) {
    const codes = await Promise.all(expectCode.map((address) => client.getCode({ address })))
    if (codes.every((c) => c && c !== '0x')) {
      console.log(`${label}: already done (${expectCode.join(', ')})`)
      return null
    }
  }
  const tx = await prepareFrameTx(client, {
    sender: privateKeyToAddress(privateKey),
    frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n }), ...frames],
    signatures: [secp256k1Placeholder()],
  })
  return execute(client, tx, [privateKey], { label })
}
