import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterHome } from './home.ts'

// The mark is local: it says the person put the workspace to sleep, which Vercel cannot tell
// apart from a sandbox that stopped on its own timeout.
function markPath(home: AdapterHome, name: string): string {
  return join(home.state, `${name}.asleep`)
}

export function markAsleep(home: AdapterHome, name: string): void {
  writeFileSync(markPath(home, name), '', { mode: 0o600 })
}

export function clearAsleep(home: AdapterHome, name: string): void {
  rmSync(markPath(home, name), { force: true })
}

export function isAsleep(home: AdapterHome, name: string): boolean {
  return existsSync(markPath(home, name))
}
