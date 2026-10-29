// Offline: one proof of each circuit against a local tree, each checked against its key and its
// public signals in the order Registry.yul passes them. No chain, no key.
import { keccak256, toHex } from 'viem'
import { DENOMINATION, ETH, ETH_TAG, FEE, How, H, batchWords, claimWords, innerOf, leafOf, prove, roundStatement, secretsOf, spendWords, tagOf, token, treeOf, verifyWords } from './x10.js'

const base = keccak256(toHex('selfcheck'))
const s = (l: string) => secretsOf(base, l)
const owners = ['a', 'b', 'c', 'd', 'e'].map(s)
const leaves = [...owners.map((o) => leafOf(ETH_TAG, innerOf(o), DENOMINATION)), 1n, 2n, 3n]
const tree = treeOf(leaves)
const tagOut = tagOf(token.address)

const spend = await spendWords({ tag: ETH_TAG, secrets: owners[0], value: DENOMINATION, index: 0, amountOut: DENOMINATION, refundInner: innerOf(s('a/refund')), how: How.COMPLETE, to: ETH, fee: FEE, tagOut, partial: innerOf(s('a/out')), minOut: 1n }, tree)
console.log(`kernel: ${spend.ms} ms, ${spend.words.length} words`)
const claim = await claimWords(tagOut, innerOf(s('a/out')), 12345n)
console.log(`import: ${claim.ms} ms, id ${claim.id.toString(16).slice(0, 8)}`)
const batch = await batchWords(leaves, 0)
console.log(`batch8: ${batch.ms} ms, new root ${batch.newRoot === tree.root}`)
const round = roundStatement(owners.slice(1, 5).map((secrets, i) => ({ secrets, index: i + 1 })), tree, { destination: ETH, fee: FEE, tagOut, minOut: 4n })
const t0 = Date.now()
const r = await prove('round4', round.witness, round.publics)
console.log(`round4: ${Date.now() - t0} ms, verifies ${await verifyWords('round4', r.proof, round.publics)}`)
console.log('H(1,2)', H(1n, 2n).toString(16).slice(0, 8))
process.exit(0)
