import type { Command } from './commands.ts'
import { resolveHome } from './home.ts'
import { describeSandboxes, type SandboxRow } from './sandbox-report.ts'

function formatRows(rows: SandboxRow[]): string {
  if (rows.length === 0) return 'no sandboxes\n'
  const nameWidth = Math.max('NAME'.length, ...rows.map((row) => row.name.length))
  const stateWidth = Math.max('STATE'.length, ...rows.map((row) => row.state.length))
  const line = (name: string, state: string, workspace: string): string =>
    `${name.padEnd(nameWidth)}  ${state.padEnd(stateWidth)}  ${workspace}\n`
  return [
    line('NAME', 'STATE', 'WORKSPACE'),
    ...rows.map((row) => line(row.name, row.state, row.workspace ?? '(none: orphan)')),
  ].join('')
}

export const listCommand: Command = {
  readsPayload: false,
  async run({ env, stderr, sandboxes }) {
    const home = resolveHome(env)
    stderr.write(formatRows(describeSandboxes(home, await sandboxes().list())))
  },
}
