import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { type ProcessControl, run } from '../../src/main.ts'
import type { SandboxProvider } from '../../src/sandbox-session.ts'
import { fakeNetwork } from './fake-network.ts'
import { fakeProcess } from './fake-process.ts'

export interface CliRun {
  code: number
  stdout: string
  stderr: string
  // What the tunnel wrote to the person's side (what ssh would receive).
  tunnelOutput: Buffer
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
  // Redirects the Vercel API and the published URL to these local servers.
  network?: { apiUrl: string; bridgePort: number }
  // Replaces the Vercel sandboxes `create` would make.
  sandboxes?: SandboxProvider
  // Bytes the tunnel reads from the person's side (what ssh would send).
  tunnelInput?: Readable
  // Makes every write to the tunnel's output fail, as a closed ssh would (EPIPE).
  failTunnelWrites?: boolean
  // Reuse the user home of an earlier run instead of creating a fresh one.
  userHome?: string
  // Stands in for the process: where signals arrive and the exit code is asked for.
  process?: ProcessControl
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
  const tunnelChunks: Buffer[] = []
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
    sandboxes: options.sandboxes,
    process: options.process ?? fakeProcess(),
    network: options.network
      ? fakeNetwork(options.network.apiUrl, options.network.bridgePort)
      : fakeNetwork('http://127.0.0.1:1', 1),
    tunnel: {
      input: options.tunnelInput ?? Readable.from([]),
      output: new Writable({
        write(chunk: Buffer, _encoding, done) {
          if (options.failTunnelWrites) return done(new Error('write EPIPE'))
          tunnelChunks.push(chunk)
          done()
        },
      }),
    },
  })
  return {
    code,
    stdout,
    stderr,
    tunnelOutput: Buffer.concat(tunnelChunks),
    home,
    userHome,
    questions,
    env,
    readLog: () => readFileSync(join(home, 'lifecycle.log'), 'utf8'),
  }
}
