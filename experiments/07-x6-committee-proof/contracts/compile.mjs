// Compiles CommitteeAccount.yul with solc-js 0.8.37 (package.json pins it), with exp-frames'
// settings: EVM version osaka, the optimizer on at 200 runs. Writes CommitteeAccount.hex, the
// creation code before the root and the verifier are appended. test/x6.test.ts compiles it again and
// requires the same bytes.
// usage: node experiments/07-x6-committee-proof/contracts/compile.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const solc = createRequire(import.meta.url)('solc')
const here = new URL('.', import.meta.url).pathname

export function compile() {
  const input = {
    language: 'Yul',
    sources: { 'CommitteeAccount.yul': { content: readFileSync(`${here}CommitteeAccount.yul`, 'utf8') } },
    settings: { evmVersion: 'osaka', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['evm.bytecode.object'] } } },
  }
  const out = JSON.parse(solc.compile(JSON.stringify(input)))
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error')
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'))
  const [contract] = Object.values(out.contracts['CommitteeAccount.yul'])
  return `0x${contract.evm.bytecode.object}`
}

if (process.argv[1] && process.argv[1].endsWith('compile.mjs')) {
  const hex = compile()
  if (process.argv.includes('--check')) {
    if (readFileSync(`${here}CommitteeAccount.hex`, 'utf8').trim() !== hex) throw new Error('CommitteeAccount.hex is stale')
    console.log('CommitteeAccount.hex matches')
  } else {
    writeFileSync(`${here}CommitteeAccount.hex`, `${hex}\n`)
    console.log(`CommitteeAccount.hex: ${(hex.length - 2) / 2} bytes, solc ${solc.version()}`)
  }
}
