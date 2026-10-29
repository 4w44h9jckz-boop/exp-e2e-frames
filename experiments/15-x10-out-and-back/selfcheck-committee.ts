// Offline: the round proved by the three-member committee, against a local tree. No chain.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keccak256, toHex } from 'viem'
import { committeeProve } from './committee.js'
import { DENOMINATION, ETH, ETH_TAG, FEE, innerOf, leafOf, roundStatement, secretsOf, tagOf, token, treeOf } from './x10.js'

const root = new URL('../../', import.meta.url).pathname
const work = join(root, 'work')
const base = keccak256(toHex('selfcheck'))
const owners = ['a', 'b', 'c', 'd', 'e'].map((l) => secretsOf(base, l))
const leaves = [...owners.map((o) => leafOf(ETH_TAG, innerOf(o), DENOMINATION)), 1n, 2n, 3n]
const tree = treeOf(leaves)
const st = roundStatement(owners.slice(1, 5).map((secrets, i) => ({ secrets, index: i + 1 })), tree, { destination: ETH, fee: FEE, tagOut: tagOf(token.address), minOut: 4n })
const dir = mkdtempSync(join(tmpdir(), 'x10-committee-'))
try {
  const { record } = await committeeProve({
    cocircom: join(work, 'target-cocircom/release/co-circom'),
    cosnarks: join(work, 'co-snarks-436f63fa17f2'),
    nodeModules: join(root, 'node_modules'),
    dir, pub: st.pub, owners: st.owners, publics: st.publics,
  })
  console.log(JSON.stringify({ witnessMillis: record.witnessMillis, provingMillis: record.provingMillis, loopback: record.loopback, membersAgree: record.membersAgree, signalsMatch: record.signalsMatch, verifies: record.verifies }))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
process.exit(0)
