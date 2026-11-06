// The local chain's simulated writes (docs/simulated-writes.md): a smoke test.
//
// It starts the local ethrex with ethrex-writes.patch applied, puts two contracts in its genesis,
// and simulates one frame transaction:
//   - an account whose VERIFY approves unconditionally (no key of any kind), the sender and payer;
//   - a writer, storage[calldata word 0] = calldata word 1;
//   - the transaction: [VERIFY, SENDER set(1, 5), SENDER set(2, 2^256 - 1)], the second write being
//     the kind a signer was not told about.
// It checks that `writes` names both slots with their before and after, then sends the transaction
// and checks the chain's state after inclusion equals the simulated after-values.
//
// Usage: npx tsx scripts/simulated-writes-smoke.ts   (from the repository root)
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Address, type Hex, concatHex, pad, toHex } from 'viem'
import { run, startLocalChain } from '../src/e2e/index.js'
import { compileYul } from '../src/exp-frames/contracts.js'
import * as L from '../experiments/19-x14-hash-based-stealth-addresses-under-8288/lean.js'
import { Approve, STORAGE_SET_STATE_GAS, type FrameTx, frameTxHash, senderFrame, serializeFrameTx, verifyFrame, waitForFrameTxReceipt } from '../src/exp-frames/frametx/index.js'

const root = new URL('../', import.meta.url).pathname
delete process.env.PRIVATE_KEY

function yul(name: string, body: string): Hex {
  const file = join(root, 'work', `writes-smoke-${name}.yul`)
  writeFileSync(file, `object "${name}" { code { ${body} } }`)
  return compileYul(file)
}
// VERIFY approves execution and payment; any other call stops.
const ACCOUNT_CODE = yul('OpenAccount', `
  function txparam(p) -> v { v := verbatim_1i_1o(hex"b0", p) }
  function frameparam(p, f) -> v { v := verbatim_2i_1o(hex"b3", f, p) }
  if eq(frameparam(0x02, txparam(0x0a)), 1) { verbatim_3i_0o(hex"aa", 0, 0, 3) }
  stop()`)
const WRITER_CODE = yul('Writer', `sstore(calldataload(0), calldataload(32)) stop()`)

const ACCOUNT = '0x00000000000000000000000000000000000057a1' as Address
const WRITER = '0x00000000000000000000000000000000000057a2' as Address
const word = (n: bigint) => pad(toHex(n), { size: 32 })
const MAX = (1n << 256n) - 1n

const chain = await startLocalChain({
  root, label: 'writes-smoke', setting: 'written', chainId: 8141,
  prover: L.PROVER,
  programs: join(root, 'experiments/19-x14-hash-based-stealth-addresses-under-8288/programs'),
  alloc: { [ACCOUNT]: { balance: '0xde0b6b3a7640000', code: ACCOUNT_CODE }, [WRITER]: { balance: '0x0', code: WRITER_CODE } },
})
let failed = 0
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++ }
try {
  const ethrex = (await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: join(root, 'work/ethrex') })).trim()
  console.log(`local chain ${chain.chainId}, ethrex ${ethrex}`)
  const tx: FrameTx = {
    chainId: chain.chainId, nonceKeys: [0x57a1n], nonceSeq: 0n, sender: ACCOUNT, signatures: [], blobVersionedHashes: [],
    fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 100n, maxFeePerBlobGas: 0n },
    frames: [
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: null, execution: 30_000n, state: STORAGE_SET_STATE_GAS * 2n }),
      senderFrame({ target: WRITER, data: concatHex([word(1n), word(5n)]), execution: 50_000n, state: STORAGE_SET_STATE_GAS }),
      senderFrame({ target: WRITER, data: concatHex([word(2n), word(MAX)]), execution: 50_000n, state: STORAGE_SET_STATE_GAS }),
    ],
  }
  const raw = serializeFrameTx(tx)
  const call = async (method: string, params: unknown[]) => {
    const r = await fetch(chain.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    const b = (await r.json()) as { result?: any; error?: { message: string } }
    if (b.error) throw new Error(`${method}: ${b.error.message}`)
    return b.result
  }
  const sim = await call('ethrex_simulateFrameTransaction', [raw, 'latest'])
  console.log(JSON.stringify({ valid: sim.valid, violation: sim.violation, executionStatus: sim.executionStatus, writes: sim.writes }, null, 1))
  check(sim.valid === true && sim.executionStatus === 'success', 'the transaction simulates valid and successful')
  check(Array.isArray(sim.writes), 'the simulation returns writes')
  const w = (sim.writes ?? []).find((x: any) => x.address.toLowerCase() === WRITER.toLowerCase())
  const slot = (n: bigint) => (w?.storage ?? []).find((s: any) => BigInt(s.slot) === n)
  check(!!slot(1n) && BigInt(slot(1n).before) === 0n && BigInt(slot(1n).after) === 5n, 'the listed write: writer slot 1, 0 -> 5')
  check(!!slot(2n) && BigInt(slot(2n).before) === 0n && BigInt(slot(2n).after) === MAX, 'the unlisted write: writer slot 2, 0 -> 2^256 - 1')
  const a = (sim.writes ?? []).find((x: any) => x.address.toLowerCase() === ACCOUNT.toLowerCase())
  check(!!a?.balance && BigInt(a.balance[1]) < BigInt(a.balance[0]), 'the payer\'s balance falls by the fee')
  check((sim.writes ?? []).every((x: any) => [ACCOUNT, WRITER].map((y) => y.toLowerCase()).includes(x.address.toLowerCase()) || x.storage.length > 0 || x.balance), 'every other write is a fee or a nonce record')

  const hash = await call('eth_sendRawTransaction', [raw])
  check(hash.toLowerCase() === frameTxHash(tx).toLowerCase(), 'sent')
  await waitForFrameTxReceipt(chain.client, hash as Hex, 60_000)
  for (const n of [1n, 2n]) {
    const onChain = BigInt(await call('eth_getStorageAt', [WRITER, word(n), 'latest']))
    check(onChain === BigInt(slot(n)?.after ?? -1), `after inclusion, writer slot ${n} equals the simulated after-value`)
  }
  for (const x of sim.writes ?? []) for (const s of x.storage) {
    const onChain = BigInt(await call('eth_getStorageAt', [x.address, s.slot, 'latest']))
    check(onChain === BigInt(s.after), `after inclusion, ${x.address} slot ${s.slot.slice(0, 10)}... equals the simulated after-value`)
  }
} finally {
  await chain.stop()
}
console.log(failed ? `${failed} check(s) failed` : 'every check passed')
process.exit(failed ? 1 : 0)
