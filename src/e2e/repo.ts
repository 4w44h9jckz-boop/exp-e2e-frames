import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { run } from './sh.js'

/** A repository at one commit: what an experiment's pins.json names for each piece. */
export type Pin = { url: string; commit: string; why: string }

/**
 * Checks out `pin` into `work/<name>-<commit>` with no history, once. The directory is reused only
 * if it is already at that commit, so a build never mixes two commits.
 */
export async function checkout(name: string, pin: Pin, work: string): Promise<string> {
  if (!/^[0-9a-f]{40}$/.test(pin.commit)) throw new Error(`${name}: pin a full 40-character commit`)
  const dir = join(work, `${name}-${pin.commit.slice(0, 12)}`)
  if (existsSync(join(dir, '.git'))) {
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).trim()
    if (head === pin.commit) return dir
    throw new Error(`${dir} is at ${head}, not ${pin.commit}; remove it`)
  }
  mkdirSync(dir, { recursive: true })
  await run('git', ['init', '-q'], { cwd: dir })
  await run('git', ['fetch', '-q', '--depth', '1', pin.url, pin.commit], { cwd: dir })
  await run('git', ['checkout', '-q', 'FETCH_HEAD'], { cwd: dir })
  return dir
}
