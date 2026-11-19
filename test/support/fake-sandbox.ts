import type { ExecOptions, SandboxProvider, SandboxSession } from '../../src/sandbox-session.ts'
import type { LocalSshd } from './local-sshd.ts'

export interface FakeSandboxes extends SandboxProvider {
  created: { name: string; ports: number[] }[]
  commands: string[]
  files: { path: string; content: string; mode: number }[]
  deleted: string[]
}

export interface FakeSandboxOptions {
  // Makes any command containing this text fail, as a broken install would.
  failOn?: string
  // Stops the sshd from trusting the key create writes, so the SSH check fails.
  withholdKey?: boolean
  // Called with each new sandbox's name, e.g. to make the fake Vercel API know it.
  onCreate?(name: string): void
}

const HOME = '/vercel'

// A sandbox that runs nothing: it answers the identity questions, records every command and file,
// and trusts the public key create writes on the local sshd, which stands in for the sandbox's.
export function fakeSandboxes(sshd: LocalSshd, options: FakeSandboxOptions = {}): FakeSandboxes {
  const fake: FakeSandboxes = {
    created: [],
    commands: [],
    files: [],
    deleted: [],
    async create(request) {
      fake.created.push(request)
      options.onCreate?.(request.name)
      const session: SandboxSession = {
        name: request.name,
        async exec(command: string, _options?: ExecOptions) {
          fake.commands.push(command)
          if (options.failOn && command.includes(options.failOn)) {
            throw new Error(`command failed: ${command}`)
          }
          if (command === 'id -un') return sshd.user
          if (command === 'printf %s "$HOME"') return HOME
          return ''
        },
        async writeFile(path, content, mode) {
          fake.files.push({ path, content, mode })
          if (path.endsWith('authorized_keys') && !options.withholdKey) sshd.authorizeKey(content)
        },
        async delete() {
          fake.deleted.push(request.name)
        },
      }
      return session
    },
  }
  return fake
}
