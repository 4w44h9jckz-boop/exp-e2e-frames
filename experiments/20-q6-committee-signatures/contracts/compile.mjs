// Compiles experiment 20's contracts with solc-js 0.8.37 (package.json pins it), EVM osaka, the
// optimizer on at 200 runs, as the other experiments do. Yul has no include, so each contract's
// `// @include Named.yul.inc` line is replaced by that file, the committee's shared check, before
// compiling. Writes <Name>.hex, the creation code before the committee is appended; test/q6.test.ts
// compiles them again and requires the same bytes.
// usage: node experiments/20-q6-committee-signatures/contracts/compile.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const solc = createRequire(import.meta.url)('solc')
const here = new URL('.', import.meta.url).pathname
export const NAMES = ['NamedResultBoard', 'NamedExitVault', 'NamedReadPool']

export function source(name) {
  const inc = readFileSync(`${here}Named.yul.inc`, 'utf8')
  return readFileSync(`${here}${name}.yul`, 'utf8').replace('            // @include Named.yul.inc\n', inc)
}

export function compile(name) {
  const input = {
    language: 'Yul',
    sources: { [`${name}.yul`]: { content: source(name) } },
    settings: { evmVersion: 'osaka', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['evm.bytecode.object'] } } },
  }
  const out = JSON.parse(solc.compile(JSON.stringify(input)))
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error')
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'))
  const [contract] = Object.values(out.contracts[`${name}.yul`])
  return `0x${contract.evm.bytecode.object}`
}

if (process.argv[1] && process.argv[1].endsWith('compile.mjs')) {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  for (const name of only.length ? only : NAMES) {
    const hex = compile(name)
    if (process.argv.includes('--check')) {
      if (readFileSync(`${here}${name}.hex`, 'utf8').trim() !== hex) throw new Error(`${name}.hex is stale`)
      console.log(`${name}.hex matches`)
    } else {
      writeFileSync(`${here}${name}.hex`, `${hex}\n`)
      console.log(`${name}.hex: ${(hex.length - 2) / 2} bytes, solc ${solc.version()}`)
    }
  }
}
