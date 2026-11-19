import { createCommand } from './create.ts'
import type { VercelCredentials } from './credentials.ts'
import { destroyCommand } from './destroy.ts'
import { doctorCommand } from './doctor.ts'
import { UserError } from './errors.ts'
import { resumeCommand, suspendCommand } from './lifecycle.ts'
import type { LifecyclePayload } from './lifecycle-payload.ts'
import { listCommand } from './list.ts'
import type { Logger, Sink } from './logger.ts'
import { type Network, proxyCommand, type Tunnel } from './proxy.ts'
import { pullCommand } from './pull.ts'
import type { SandboxProvider } from './sandbox-session.ts'
import { setupCommand, uninstallCommand } from './setup.ts'

// The part of the process that `create` needs to clean up when it is cancelled.
export type CancelSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP'

export interface ProcessControl {
  once(signal: CancelSignal, listener: (signal: CancelSignal) => void): unknown
  off(signal: CancelSignal, listener: (signal: CancelSignal) => void): unknown
  exit(code: number): unknown
}

export interface CommandContext {
  args: string[]
  env: NodeJS.ProcessEnv
  // Asks the person a yes/no question; false when there is nobody to ask.
  confirm(question: string): Promise<boolean>
  logger: Logger
  // The directory the person ran the command from; `pull` copies into the repository it is in.
  cwd: string
  // Reports what a command did to the person; stdout stays reserved for `create`.
  stderr: Sink
  // Only `create` writes here: its JSON result is the one thing Orca reads from stdout.
  stdout: Sink
  // The Vercel API and the published URLs: injected so tests can point them at local servers.
  network: Network
  // What ssh sends and receives; only `proxy` uses it, since stdout belongs to `create`.
  tunnel: Tunnel
  // Where signals arrive; only `create` listens, to delete its sandbox when cancelled.
  process: ProcessControl
  // Resolved on demand so a command that never calls the API does not need them.
  credentials(): VercelCredentials
  // The Vercel sandboxes; resolved on demand like the credentials.
  sandboxes(): SandboxProvider
  // Present for suspend, resume and destroy, which Orca feeds a lifecycle payload.
  payload?: LifecyclePayload
}

export interface Command {
  readsPayload: boolean
  run(context: CommandContext): Promise<void>
}

function notImplemented(name: string): Command['run'] {
  return async () => {
    throw new UserError(`vercel-orca ${name} is not implemented yet`)
  }
}

function command(name: string, readsPayload = false): [string, Command] {
  return [name, { readsPayload, run: notImplemented(name) }]
}

export const COMMANDS: ReadonlyMap<string, Command> = new Map([
  ['create', createCommand],
  ['suspend', suspendCommand],
  ['resume', resumeCommand],
  ['destroy', destroyCommand],
  ['proxy', proxyCommand],
  ['setup', setupCommand],
  ['uninstall', uninstallCommand],
  ['doctor', doctorCommand],
  ['pull', pullCommand],
  ['list', listCommand],
])
