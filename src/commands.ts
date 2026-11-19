import type { VercelCredentials } from './credentials.ts'
import { UserError } from './errors.ts'
import type { LifecyclePayload } from './lifecycle-payload.ts'
import type { Logger, Sink } from './logger.ts'
import { setupCommand, uninstallCommand } from './setup.ts'

export interface CommandContext {
  args: string[]
  env: NodeJS.ProcessEnv
  // Asks the person a yes/no question; false when there is nobody to ask.
  confirm(question: string): Promise<boolean>
  logger: Logger
  // Only `create` writes here: its JSON result is the one thing Orca reads from stdout.
  stdout: Sink
  // Resolved on demand so a command that never calls the API does not need them.
  credentials(): VercelCredentials
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
  command('create'),
  command('suspend', true),
  command('resume', true),
  command('destroy', true),
  command('proxy'),
  ['setup', setupCommand],
  ['uninstall', uninstallCommand],
  command('doctor'),
  command('pull'),
  command('list'),
])
