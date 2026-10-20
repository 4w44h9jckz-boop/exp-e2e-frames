// Claim 1 testnet ETH for the run account (limit: once per hour per address and per IP).
// usage: npm run faucet
import { formatEther } from 'viem'
import { FAUCET_URL, loadKey, rpc } from '../src/e2e/index.js'

const { address } = loadKey()
console.log(`claiming for ${address}...`)
const res = await fetch(`${FAUCET_URL}/api/claim`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ address }),
})
console.log(await res.text())
const balance = BigInt(await rpc('eth_getBalance', [address, 'latest']))
console.log(`balance now ${formatEther(balance)} ETH (the faucet transfer may take a slot to land)`)
