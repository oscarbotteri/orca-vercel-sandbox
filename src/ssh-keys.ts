import { spawnSync } from 'node:child_process'
import { chmodSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { UserError } from './errors.ts'
import type { AdapterHome } from './home.ts'

export interface SandboxKey {
  privatePath: string
  publicKey: string
}

export function keyPath(home: AdapterHome, name: string): string {
  return join(home.keys, name)
}

// One ed25519 pair per sandbox. The private half stays at keyPath (600) and is never sent anywhere.
export function generateKey(home: AdapterHome, name: string): SandboxKey {
  const privatePath = keyPath(home, name)
  const result = spawnSync(
    'ssh-keygen',
    ['-q', '-t', 'ed25519', '-N', '', '-C', `vercel-orca ${name}`, '-f', privatePath],
    { encoding: 'utf8' },
  )
  if (result.error || result.status !== 0) {
    throw new UserError(`ssh-keygen failed: ${result.error?.message ?? result.stderr.trim()}`)
  }
  chmodSync(privatePath, 0o600)
  return { privatePath, publicKey: readFileSync(`${privatePath}.pub`, 'utf8').trim() }
}

export function removeKey(home: AdapterHome, name: string): void {
  rmSync(keyPath(home, name), { force: true })
  rmSync(`${keyPath(home, name)}.pub`, { force: true })
}
