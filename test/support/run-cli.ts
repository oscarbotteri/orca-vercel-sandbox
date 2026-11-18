import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../../src/main.ts'

export interface CliRun {
  code: number
  stdout: string
  stderr: string
  home: string
  readLog(): string
}

export interface CliOptions {
  stdin?: string
  env?: Record<string, string>
}

const homes: string[] = []

export function cleanupHomes(): void {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
}

export async function runCli(argv: string[], options: CliOptions = {}): Promise<CliRun> {
  const home = mkdtempSync(join(tmpdir(), 'vercel-orca-test-'))
  homes.push(home)
  let stdout = ''
  let stderr = ''
  const code = await run(argv, {
    env: { VERCEL_ORCA_HOME: home, ...options.env },
    readStdin: async () => options.stdin ?? '',
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
    readLog: () => readFileSync(join(home, 'lifecycle.log'), 'utf8'),
  }
}
