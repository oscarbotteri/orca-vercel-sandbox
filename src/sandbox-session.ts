import { Sandbox } from '@vercel/sandbox'
import type { VercelCredentials } from './credentials.ts'
import { reasonOf, UserError } from './errors.ts'
import type { Network } from './proxy.ts'

export interface ExecOptions {
  // Run as root.
  sudo?: boolean
  // Return once the command has started instead of when it ends (a server that keeps running).
  background?: boolean
}

// What `create` needs from a sandbox, so tests can stand in for Vercel.
export interface SandboxSession {
  name: string
  // Runs a shell command and returns its stdout; a non-zero exit throws.
  exec(command: string, options?: ExecOptions): Promise<string>
  writeFile(path: string, content: string | Uint8Array, mode: number): Promise<void>
  delete(): Promise<void>
}

export interface SandboxRequest {
  name: string
  ports: number[]
}

export interface SandboxProvider {
  create(request: SandboxRequest): Promise<SandboxSession>
}

function wrap(sandbox: Sandbox): SandboxSession {
  return {
    name: sandbox.name,
    async exec(command, { sudo = false, background = false } = {}) {
      const params = { cmd: 'sh', args: ['-c', command], sudo }
      if (background) {
        await sandbox.runCommand({ ...params, detached: true })
        return ''
      }
      const finished = await sandbox.runCommand(params)
      if (finished.exitCode !== 0) {
        throw new UserError(
          `sandbox command failed (exit ${finished.exitCode}): ${command}\n${await finished.stderr()}`,
        )
      }
      return finished.stdout()
    },
    writeFile: (path, content, mode) => sandbox.writeFiles([{ path, content, mode }]),
    async delete() {
      await sandbox.delete()
    },
  }
}

export function vercelSandboxes(credentials: VercelCredentials, network: Network): SandboxProvider {
  return {
    async create({ name, ports }) {
      try {
        const sandbox = await Sandbox.create({
          name,
          ports,
          persistent: true,
          ...credentials,
          fetch: network.fetch,
        })
        return wrap(sandbox)
      } catch (error) {
        throw new UserError(`cannot create sandbox ${name} on Vercel: ${reasonOf(error)}`, {
          cause: error,
        })
      }
    },
  }
}
