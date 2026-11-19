import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CheckoutSource } from './git-bundle.ts'
import type { AdapterHome } from './home.ts'

function labelPath(home: AdapterHome, name: string): string {
  return join(home.state, `${name}.workspace`)
}

// What Orca's workspace is called here: the repository and the branch (or commit) it was cut from.
export function workspaceLabel(source: CheckoutSource): string {
  return `${source.repoName} (${source.branch ?? `detached at ${source.commit.slice(0, 7)}`})`
}

export function recordWorkspace(home: AdapterHome, name: string, label: string): void {
  writeFileSync(labelPath(home, name), `${label}\n`, { mode: 0o600 })
}

export function forgetWorkspace(home: AdapterHome, name: string): void {
  rmSync(labelPath(home, name), { force: true })
}

export function workspaceOf(home: AdapterHome, name: string): string | undefined {
  try {
    return readFileSync(labelPath(home, name), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}
