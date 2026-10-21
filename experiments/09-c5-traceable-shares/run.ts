// C5: deal shares with a one-way key per holder, build reconstruction boxes, trace them, and
// convict the traced holders on chain: one transaction deploys StakeSlash with every holder's
// stake and the Merkle root of the key, one sends evidence forged against an innocent holder,
// and one sends the perfect box's trace as evidence.
// usage: npx tsx experiments/09-c5-traceable-shares/run.ts [attempt-label] [holders] [threshold]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Hex, concatHex, createPublicClient, createWalletClient, defineChain, http, numberToHex, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { RPC_URL, chainFacts, loadKey, rpc, run } from '../../src/e2e/index.js'

const here = new URL('.', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
const attempt = process.argv[2] ?? new Date().toISOString()
const holders = process.argv[3] ?? '16'
const threshold = process.argv[4] ?? '7'
const STAKE = parseEther('0.001')
const FORGED_GAS = 200_000n

console.log('building the tracer')
const manifest = join(here, 'rust/Cargo.toml')
const target = join(root, 'work', 'target-c5')
await run('cargo', ['build', '-q', '--release', '--locked', '--manifest-path', manifest], { cwd: root, env: { CARGO_TARGET_DIR: target } })
const out = join(root, 'work', `c5-${Date.now()}.json`)
const stdout = await run(join(target, 'release', 'c5-tracer'), [], { cwd: root, env: { HOLDERS: holders, THRESHOLD: threshold, RECORD: out } })
console.log(stdout)
const traced = JSON.parse(readFileSync(out, 'utf8'))

const chainId = Number(await rpc('eth_chainId', []))
const chain = defineChain({ id: chainId, name: 'hegota', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } })
const account = privateKeyToAccount(loadKey().privateKey)
const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) })
const client = createPublicClient({ chain, transport: http(RPC_URL) })
const word = (n: number | bigint) => numberToHex(BigInt(n), { size: 32 })
// The node's estimate with fee fields caps the search at the funder's balance over the block's
// gas limit, which fails; estimated without them, with a fifth added.
const gasFor = async (tx: { to?: Hex; data: Hex; value?: bigint }) =>
  (BigInt(await rpc('eth_estimateGas', [{ from: account.address, to: tx.to, data: tx.data, value: numberToHex(tx.value ?? 0n) }])) * 6n) / 5n

const s = traced.scheme
const code = `0x${readFileSync(join(here, 'contracts/StakeSlash.hex'), 'utf8').trim()}` as Hex
const deployData = concatHex([code, s.root, word(s.n), word(s.depth)])
const stakeValue = STAKE * BigInt(s.n)
const stakeHash = await wallet.sendTransaction({ data: deployData, value: stakeValue, gas: await gasFor({ data: deployData, value: stakeValue }) })
const stakeReceipt = await client.waitForTransactionReceipt({ hash: stakeHash })
const address = stakeReceipt.contractAddress as Hex
console.log(`stake ${stakeHash}: block ${stakeReceipt.blockNumber}, ${stakeReceipt.gasUsed} gas, StakeSlash at ${address}`)
const stakeOf = async (i: number, block?: bigint) =>
  BigInt(await client.call({ to: address, data: word(i), blockNumber: block }).then((r) => r.data ?? '0x0'))
const stakesBefore = await Promise.all([...Array(s.n).keys()].map((i) => stakeOf(i)))

// Forged: a random w for an innocent holder, with that holder's true path.
let forgedAnswer: unknown = null
try {
  await gasFor({ to: address, data: traced.forged.calldata })
} catch (e) {
  forgedAnswer = (e as Error).message
}
const forgedHash = await wallet.sendTransaction({ to: address, data: traced.forged.calldata, gas: FORGED_GAS })
const forgedReceipt = await client.waitForTransactionReceipt({ hash: forgedHash })
console.log(`forged against holder ${traced.forged.innocent}: ${forgedHash}, block ${forgedReceipt.blockNumber}, status ${forgedReceipt.status}`)

const balanceBefore = await client.getBalance({ address: account.address })
const slashRaw = await wallet.signTransaction(await wallet.prepareTransactionRequest({ to: address, data: traced.slash.calldata, gas: await gasFor({ to: address, data: traced.slash.calldata }) }))
const slashHash = await wallet.sendRawTransaction({ serializedTransaction: slashRaw })
const slashReceipt = await client.waitForTransactionReceipt({ hash: slashHash })
const slashTx = await client.getTransaction({ hash: slashHash })
const block = await client.getBlock({ blockNumber: slashReceipt.blockNumber })
const stakesAfter = await Promise.all([...Array(s.n).keys()].map((i) => stakeOf(i)))
const balanceAfter = await client.getBalance({ address: account.address })
console.log(`slash ${slashHash}: block ${slashReceipt.blockNumber}, status ${slashReceipt.status}, ${slashReceipt.gasUsed} gas of ${block.gasLimit}`)

const lock = readFileSync(join(here, 'rust/Cargo.lock'), 'utf8')
const crate = (name: string) => lock.match(new RegExp(`name = "${name}"\\nversion = "([^"]+)"`))?.[1]
const record = {
  experiment: '09-c5-traceable-shares',
  attempt,
  ranAt: new Date().toISOString(),
  pins: {},
  crates: Object.fromEntries(['ark-bn254', 'ark-ff', 'ark-std', 'tiny-keccak'].map((c) => [c, crate(c)])),
  client: await rpc('web3_clientVersion', []),
  commands: [
    `npx tsx experiments/09-c5-traceable-shares/run.ts ${attempt} ${holders} ${threshold}`,
    'cargo build --release --locked --manifest-path experiments/09-c5-traceable-shares/rust/Cargo.toml; HOLDERS, THRESHOLD, RECORD',
  ],
  runner: { stdout: stdout.trim().split('\n') },
  scheme: s,
  traces: traced.traces,
  tHolder: traced.tHolder,
  chain: {
    chainId,
    blockGasLimit: Number(block.gasLimit),
    stakeSlash: address,
    stakePerHolderWei: STAKE.toString(),
    stake: { ...(await chainFacts(stakeHash)), status: stakeReceipt.status === 'success' ? '0x1' : '0x0', gasUsed: Number(stakeReceipt.gasUsed), stakes: stakesBefore.map(String) },
    forged: {
      innocent: traced.forged.innocent,
      calldata: traced.forged.calldata,
      estimate: forgedAnswer,
      hash: forgedHash,
      block: Number(forgedReceipt.blockNumber),
      status: forgedReceipt.status === 'success' ? '0x1' : '0x0',
      gasUsed: Number(forgedReceipt.gasUsed),
      accepted: forgedReceipt.status === 'success',
      stakeAfter: stakesAfter[traced.forged.innocent].toString(),
    },
    slash: {
      trace: traced.slash.trace,
      indices: traced.slash.indices,
      calldata: traced.slash.calldata,
      calldataBytes: (traced.slash.calldata.length - 2) / 2,
      hash: slashHash,
      block: Number(slashReceipt.blockNumber),
      status: slashReceipt.status === 'success' ? '0x1' : '0x0',
      gasUsed: Number(slashReceipt.gasUsed),
      gasLimit: Number(slashTx.gas),
      bytes: (slashRaw.length - 2) / 2,
      raw: slashRaw,
      logs: slashReceipt.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })),
      stakesAfter: stakesAfter.map(String),
      callerGainedWei: (balanceAfter - balanceBefore).toString(),
      gasPaidWei: (slashReceipt.gasUsed * slashReceipt.effectiveGasPrice).toString(),
    },
  },
}
const dir = join(here, 'results')
mkdirSync(dir, { recursive: true })
const path = join(dir, `${attempt.replace(/[^A-Za-z0-9-]/g, '-')}.json`)
writeFileSync(path, JSON.stringify(record, null, 2) + '\n')
console.log(`recorded ${path}`)
