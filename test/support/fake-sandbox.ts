import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import type { ExecOptions, SandboxProvider, SandboxSession } from '../../src/sandbox-session.ts'
import type { LocalSshd } from './local-sshd.ts'

export interface FakeSandboxes extends SandboxProvider {
  created: { name: string; ports: number[] }[]
  commands: string[]
  files: { path: string; content: string; mode: number }[]
  deleted: string[]
  stopped: string[]
  // Each `get`, with whether it asked to resume.
  looked: { name: string; resume: boolean }[]
}

export interface FakeSandboxOptions {
  // Makes any command containing this text fail, as a broken install would.
  failOn?: string
  // Stops the sshd from trusting the key create writes, so the SSH check fails.
  withholdKey?: boolean
  // What the sandbox reports for `id -un` and $HOME, and what its bridge log holds.
  user?: string
  home?: string
  bridgeLog?: string
  // Runs the checkout's git and rm commands for real and keeps the uploaded bundle on disk, so
  // `home` must be a writable directory. Everything else stays recorded only.
  localGit?: boolean
  // Makes stopping fail, as an API error would.
  failStop?: boolean
  // Runs when the sandbox is deleted, before the local cleanup follows.
  onDelete?(): void
  // Runs before each command; a promise that never settles holds the create at that step.
  onCommand?(command: string): void | Promise<void>
  // Holds provider.create (the sandbox exists on Vercel, the session has not come back yet).
  beforeCreateResolves?(name: string): Promise<void>
  // Called with each new sandbox's name, e.g. to make the fake Vercel API know it.
  onCreate?(name: string): void
}

const HOME = '/vercel'
const run = promisify(execFile)

// A sandbox that runs nothing: it answers the identity questions, records every command and file,
// and trusts the public key create writes on the local sshd, which stands in for the sandbox's.
export function fakeSandboxes(sshd: LocalSshd, options: FakeSandboxOptions = {}): FakeSandboxes {
  const sessions = new Map<string, SandboxSession>()
  const fake: FakeSandboxes = {
    created: [],
    commands: [],
    files: [],
    deleted: [],
    stopped: [],
    looked: [],
    async get(name, { resume = false } = {}) {
      fake.looked.push({ name, resume })
      const known = sessions.get(name)
      if (!known) throw new Error(`no sandbox ${name}`)
      return known
    },
    async create(request) {
      fake.created.push(request)
      options.onCreate?.(request.name)
      await options.beforeCreateResolves?.(request.name)
      const session: SandboxSession = {
        name: request.name,
        async exec(command: string, _options?: ExecOptions) {
          fake.commands.push(command)
          await options.onCommand?.(command)
          if (options.failOn && command.includes(options.failOn)) {
            throw new Error(`command failed: ${command}`)
          }
          if (options.localGit && /^(git|rm) /.test(command)) {
            return (await run('sh', ['-c', command])).stdout
          }
          if (command === 'id -un') return options.user ?? sshd.user
          if (command === 'printf %s "$HOME"') return options.home ?? HOME
          if (command.startsWith('tail ')) return options.bridgeLog ?? ''
          return ''
        },
        async writeFile(path, content, mode) {
          const text =
            typeof content === 'string' ? content : Buffer.from(content).toString('latin1')
          fake.files.push({ path, content: text, mode })
          if (options.localGit && path.endsWith('.bundle')) writeFileSync(path, content)
          if (path.endsWith('authorized_keys') && !options.withholdKey) sshd.authorizeKey(text)
        },
        async stop() {
          if (options.failStop) throw new Error('stop failed')
          fake.stopped.push(request.name)
        },
        async delete() {
          fake.deleted.push(request.name)
          options.onDelete?.()
        },
      }
      sessions.set(request.name, session)
      return session
    },
  }
  return fake
}
