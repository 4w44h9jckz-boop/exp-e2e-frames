import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { run } from './sh.js'
import { RPC_URL } from './env.js'

/** Builds one of kohaku-rs's examples, release profile, once per checkout. */
export async function buildExample(dir: string, pkg: string, example: string): Promise<string> {
  const bin = join(dir, 'crates', 'target', 'release', 'examples', example)
  if (!existsSync(bin)) {
    await run('cargo', ['build', '--release', '-p', pkg, '--example', example], { cwd: join(dir, 'crates') })
  }
  return bin
}

/**
 * Runs kohaku-frame-pool's `refund_withdrawal`: a fresh deposit through `RPC_URL`, then the
 * withdrawal handed to `sendRpcUrl` alone, its receipt awaited from `RPC_URL`. Its standard error
 * prints the note's preimage, so it is dropped line by line and never returned or recorded.
 */
export async function refundWithdrawal(bin: string, o: { privateKey: string; sendRpcUrl: string; rpcUrl?: string }) {
  const out = await run(bin, [], {
    cwd: '.',
    env: { PRIVATE_KEY: o.privateKey, SEND_RPC_URL: o.sendRpcUrl, RPC_URL: o.rpcUrl ?? RPC_URL },
  }).catch((e: Error) => {
    throw new Error(e.message.split('\n').filter((l) => !/^note 0x/i.test(l)).join('\n'))
  })
  const lines = out.split('\n').filter((l) => /^(deposit|withdrawal|fee):? /.test(l))
  const deposit = lines.join('\n').match(/deposit: (0x[0-9a-f]{64}) in block (\d+)/)
  const handed = lines.join('\n').match(/withdrawal: (0x[0-9a-f]{64}) handed to (\S+) only/)
  if (!handed) throw new Error(`no withdrawal hash in the output:\n${lines.join('\n')}`)
  return { stdout: lines, deposit: deposit?.[1], depositBlock: deposit ? Number(deposit[2]) : undefined, withdrawal: handed[1] }
}
