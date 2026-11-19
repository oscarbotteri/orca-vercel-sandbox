import { COMMANDS, type Command } from './commands.ts'
import { readEnv, resolveCredentials, VARIABLES } from './credentials.ts'
import { reasonOf } from './errors.ts'
import { ensureHome, resolveHome } from './home.ts'
import { parseLifecyclePayload } from './lifecycle-payload.ts'
import { createLogger, type Logger, type Sink } from './logger.ts'
import type { Network, Tunnel } from './proxy.ts'

export type { Network, Tunnel }

export interface RunIo {
  env: NodeJS.ProcessEnv
  readStdin(): Promise<string>
  confirm(question: string): Promise<boolean>
  stdout: Sink
  stderr: Sink
  network: Network
  tunnel: Tunnel
}

const EXIT_FAILED = 1
const EXIT_USAGE = 2

function usage(): string {
  return `usage: vercel-orca <command> [args]\ncommands: ${[...COMMANDS.keys()].join(', ')}`
}

// Only `create` may write to stdout (its JSON result), and it does so through io.stdout itself.
// Everything else, errors included, goes through the logger.
export async function run(argv: string[], io: RunIo): Promise<number> {
  const [name, ...args] = argv
  const command = name === undefined ? undefined : COMMANDS.get(name)
  if (name === undefined || !command) {
    io.stderr.write(`${name === undefined ? '' : `unknown command "${name}"\n`}${usage()}\n`)
    return EXIT_USAGE
  }

  const home = resolveHome(io.env)
  ensureHome(home)
  const logger = createLogger({
    file: home.lifecycleLog,
    stderr: io.stderr,
    // Read like resolveCredentials does, so the value the API sees is the one redacted.
    secrets: [readEnv(io.env, VARIABLES.token) ?? ''],
  })
  return runCommand(name, args, command, io, logger)
}

async function runCommand(
  name: string,
  args: string[],
  command: Command,
  io: RunIo,
  logger: Logger,
): Promise<number> {
  const started = Date.now()
  let subject = ''
  try {
    const payload = command.readsPayload ? parseLifecyclePayload(await io.readStdin()) : undefined
    subject = payload ? ` sandbox=${payload.sandbox}` : ''
    logger.info(`${name}${subject} started`)
    await command.run({
      args,
      env: io.env,
      confirm: io.confirm,
      logger,
      stdout: io.stdout,
      network: io.network,
      tunnel: io.tunnel,
      credentials: () => resolveCredentials(io.env),
      payload,
    })
    logger.info(`${name}${subject} done in ${Date.now() - started}ms`)
    return 0
  } catch (error) {
    const reason = reasonOf(error)
    logger.error(`${name}${subject} failed after ${Date.now() - started}ms: ${reason}`)
    return EXIT_FAILED
  }
}
