import { isAsleep } from './asleep.ts'
import type { AdapterHome } from './home.ts'
import type { SandboxSummary } from './sandbox-session.ts'
import { listSandboxHosts } from './ssh-config.ts'
import { workspaceOf } from './workspaces.ts'

export interface SandboxRow {
  name: string
  state: string
  // Absent for an orphan: no workspace points at the sandbox.
  workspace?: string
}

// A workspace owns a sandbox once `create` has written its SSH block, and loses it when the block goes.
export function describeSandboxes(home: AdapterHome, sandboxes: SandboxSummary[]): SandboxRow[] {
  const hosts = new Set(listSandboxHosts(home.sshConfig))
  return sandboxes.map(({ name, status }) => ({
    name,
    state: isAsleep(home, name) && status === 'stopped' ? 'asleep' : status,
    workspace: hosts.has(name) ? (workspaceOf(home, name) ?? 'unnamed workspace') : undefined,
  }))
}

export function orphansOf(rows: SandboxRow[]): SandboxRow[] {
  return rows.filter((row) => row.workspace === undefined)
}
