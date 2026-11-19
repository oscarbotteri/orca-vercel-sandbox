import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { UserError } from './errors.ts'
import type { AdapterHome } from './home.ts'

// What `destroy` needs to know about a sandbox that only `create` saw.
export interface SandboxState {
  // The local repository the workspace came from: saved work is fetched back into it.
  repoPath: string
  // The checkout inside the sandbox.
  projectRoot: string
  // The commit the checkout started from: work is unpushed when it is not reachable from here.
  baseCommit: string
}

function statePath(home: AdapterHome, name: string): string {
  return join(home.state, `${name}.json`)
}

export function writeSandboxState(home: AdapterHome, name: string, state: SandboxState): void {
  writeFileSync(statePath(home, name), `${JSON.stringify(state)}\n`, { mode: 0o600 })
}

export function readSandboxState(home: AdapterHome, name: string): SandboxState {
  try {
    return JSON.parse(readFileSync(statePath(home, name), 'utf8')) as SandboxState
  } catch (error) {
    throw new UserError(
      `no record of where sandbox ${name} came from, so its work cannot be saved; the sandbox stays`,
      { cause: error },
    )
  }
}

export function removeSandboxState(home: AdapterHome, name: string): void {
  rmSync(statePath(home, name), { force: true })
}
