import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../../src/main.ts'

export interface CliRun {
  code: number
  stdout: string
  stderr: string
  // The adapter's home, `~/.vercel-orca` under the temporary user home.
  home: string
  // The temporary user home, standing in for `$HOME`.
  userHome: string
  questions: string[]
  env: NodeJS.ProcessEnv
  readLog(): string
}

export interface CliOptions {
  stdin?: string
  env?: Record<string, string>
  // Answer to every confirmation prompt; declines when absent.
  confirm?: boolean
  // Reuse the user home of an earlier run instead of creating a fresh one.
  userHome?: string
  // Seed the user home before the command runs.
  beforeRun?(userHome: string): void
}

const homes: string[] = []

export function cleanupHomes(): void {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
}

export async function runCli(argv: string[], options: CliOptions = {}): Promise<CliRun> {
  const userHome = options.userHome ?? mkdtempSync(join(tmpdir(), 'vercel-orca-test-'))
  if (!options.userHome) homes.push(userHome)
  options.beforeRun?.(userHome)
  const home = join(userHome, '.vercel-orca')
  const questions: string[] = []
  let stdout = ''
  let stderr = ''
  const env = { ...process.env, HOME: userHome, VERCEL_ORCA_HOME: home, ...options.env }
  const code = await run(argv, {
    env,
    readStdin: async () => options.stdin ?? '',
    confirm: async (question) => {
      questions.push(question)
      return options.confirm ?? false
    },
    stdout: {
      write: (text) => {
        stdout += text
      },
    },
    stderr: {
      write: (text) => {
        stderr += text
      },
    },
  })
  return {
    code,
    stdout,
    stderr,
    home,
    userHome,
    questions,
    env,
    readLog: () => readFileSync(join(home, 'lifecycle.log'), 'utf8'),
  }
}
