import { type ChildProcess, spawn } from 'node:child_process'

/** Runs a command to completion; throws with its last lines if it fails. */
export function run(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env } })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${out.split('\n').slice(-20).join('\n')}`)),
    )
  })
}

/** Starts a long-running command in its own process group, so that stopping it stops its children. */
export function start(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): ChildProcess {
  return spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, detached: true })
}

/** Stops a process started with `start`, and its children. */
export async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return
  const done = new Promise((r) => child.once('exit', r))
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    return
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {}
  }, 10_000)
  await done
  clearTimeout(timer)
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Polls `check` until it returns a value, or throws after `timeoutMs`. */
export async function until<T>(what: string, check: () => Promise<T | undefined>, timeoutMs: number, everyMs = 1000): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = await check().catch(() => undefined)
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(everyMs)
  }
}
