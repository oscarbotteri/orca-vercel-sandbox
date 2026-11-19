import { Sandbox } from '@vercel/sandbox'
import type { VercelCredentials } from './credentials.ts'
import { reasonOf, UserError } from './errors.ts'
import type { Network } from './proxy.ts'
import { type SandboxSettings, toCreateParams } from './settings.ts'

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
  readFile(path: string): Promise<Buffer>
  // Stops the sandbox; its files survive and a later resume brings it back.
  stop(): Promise<void>
  delete(): Promise<void>
}

export interface SandboxRequest {
  name: string
  ports: number[]
  settings: SandboxSettings
}

export interface SandboxProvider {
  create(request: SandboxRequest): Promise<SandboxSession>
  // Looks a sandbox up; `resume` also starts it again if it is stopped.
  get(name: string, options?: { resume?: boolean }): Promise<SandboxSession>
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
    async readFile(path) {
      const content = await sandbox.readFileToBuffer({ path })
      if (!content) throw new UserError(`sandbox file not found: ${path}`)
      return content
    },
    async stop() {
      await sandbox.stop()
    },
    async delete() {
      await sandbox.delete({ deleteOrphanSnapshots: true })
    },
  }
}

// Only the latest snapshot is kept: Vercel evicts and deletes older ones as each new one is taken.
export function sandboxCreateParams({ name, ports, settings }: SandboxRequest) {
  return {
    name,
    ports,
    persistent: true,
    keepLastSnapshots: { count: 1 },
    ...toCreateParams(settings),
  }
}

export function vercelSandboxes(credentials: VercelCredentials, network: Network): SandboxProvider {
  return {
    async create(request) {
      const { name } = request
      try {
        const sandbox = await Sandbox.create({
          ...sandboxCreateParams(request),
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
    async get(name, { resume = false } = {}) {
      try {
        return wrap(await Sandbox.get({ name, resume, ...credentials, fetch: network.fetch }))
      } catch (error) {
        throw new UserError(`cannot look up sandbox ${name} on Vercel: ${reasonOf(error)}`, {
          cause: error,
        })
      }
    },
  }
}
