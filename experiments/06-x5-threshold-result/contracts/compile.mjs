// Compiles ResultBoard.yul with solc-js 0.8.37 (package.json pins it), with exp-frames'
// settings: EVM version osaka, the optimizer on at 200 runs. Writes ResultBoard.hex, the
// creation code before the committee's key is appended. test/x5.test.ts compiles it again and
// requires the same bytes.
// usage: node experiments/06-x5-threshold-result/contracts/compile.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const solc = createRequire(import.meta.url)('solc')
const here = new URL('.', import.meta.url).pathname

export function compile() {
  const input = {
    language: 'Yul',
    sources: { 'ResultBoard.yul': { content: readFileSync(`${here}ResultBoard.yul`, 'utf8') } },
    settings: { evmVersion: 'osaka', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['evm.bytecode.object'] } } },
  }
  const out = JSON.parse(solc.compile(JSON.stringify(input)))
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error')
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'))
  const [contract] = Object.values(out.contracts['ResultBoard.yul'])
  return `0x${contract.evm.bytecode.object}`
}

if (process.argv[1] && process.argv[1].endsWith('compile.mjs')) {
  const hex = compile()
  if (process.argv.includes('--check')) {
    if (readFileSync(`${here}ResultBoard.hex`, 'utf8').trim() !== hex) throw new Error('ResultBoard.hex is stale')
    console.log('ResultBoard.hex matches')
  } else {
    writeFileSync(`${here}ResultBoard.hex`, `${hex}\n`)
    console.log(`ResultBoard.hex: ${(hex.length - 2) / 2} bytes, solc ${solc.version()}`)
  }
}
