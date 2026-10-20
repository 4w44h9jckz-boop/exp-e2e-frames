// Show the run account, creating a key in .env if there is none. The key itself is never printed.
// usage: npm run account
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { formatEther } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { ENV_PATH, EXPLORER_URL, hexToNumber, loadKey, rpc } from '../src/e2e/index.js'

if (!process.env.PRIVATE_KEY) {
  const key = generatePrivateKey()
  if (!existsSync(ENV_PATH)) writeFileSync(ENV_PATH, readFileSync(new URL('../.env.example', import.meta.url)))
  const env = readFileSync(ENV_PATH, 'utf8')
  if (/^PRIVATE_KEY=.*$/m.test(env)) writeFileSync(ENV_PATH, env.replace(/^PRIVATE_KEY=.*$/m, `PRIVATE_KEY=${key}`))
  else appendFileSync(ENV_PATH, `${env.endsWith('\n') ? '' : '\n'}PRIVATE_KEY=${key}\n`)
  process.env.PRIVATE_KEY = key
  console.log('generated a new key in .env as PRIVATE_KEY')
}
const { address } = loadKey()
const balance = BigInt(await rpc('eth_getBalance', [address, 'latest']))
console.log(`PRIVATE_KEY: ${address}`)
console.log(`balance ${formatEther(balance)} ETH, nonce ${hexToNumber(await rpc('eth_getTransactionCount', [address, 'latest']))}`)
console.log(`${EXPLORER_URL}/address/${address}`)
if (balance === 0n) console.log('unfunded: run `npm run faucet`')
