import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { UserError } from './errors.ts'

export interface SandboxHost {
  name: string
  user: string
  identityFile: string
  proxyCommand: string
}

const SANDBOX_NAME = /^[A-Za-z0-9._-]+$/

export function userSshConfigPath(env: NodeJS.ProcessEnv, fallbackHome: string): string {
  return join(env.HOME || fallbackHome, '.ssh', 'config')
}

export function includeLine(sshConfigPath: string): string {
  const quoted = /\s/.test(sshConfigPath) ? `"${sshConfigPath}"` : sshConfigPath
  return `Include ${quoted}`
}

export function hasInclude(config: string, line: string): boolean {
  return config.split('\n').some((existing) => existing.trim() === line)
}

export function withInclude(config: string, line: string): string {
  return config === '' ? `${line}\n` : `${line}\n\n${config}`
}

// Inverse of withInclude: drops the line and the one blank line that was added after it.
export function withoutInclude(config: string, line: string): string {
  const lines = config.split('\n')
  const at = lines.findIndex((existing) => existing.trim() === line)
  if (at === -1) return config
  const blank = lines.length > at + 2 && lines[at + 1] === '' ? 1 : 0
  lines.splice(at, 1 + blank)
  return lines.join('\n')
}

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

export function addIncludeToUserConfig(path: string, line: string): void {
  const current = readIfExists(path)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (current !== undefined) copyFileSync(path, `${path}.vercel-orca-${Date.now()}.bak`)
  writeFileSync(path, withInclude(current ?? '', line), { mode: 0o600 })
}

export function removeIncludeFromUserConfig(path: string, line: string): void {
  const current = readIfExists(path)
  if (current === undefined || !hasInclude(current, line)) return
  const next = withoutInclude(current, line)
  // A config that held only our line is one we created.
  if (next === '') rmSync(path)
  else writeFileSync(path, next)
}

export function userConfigHasInclude(path: string, line: string): boolean {
  const current = readIfExists(path)
  return current !== undefined && hasInclude(current, line)
}

const BEGIN_MARKER = '# vercel-orca begin '

function markers(name: string): [string, string] {
  return [`${BEGIN_MARKER}${name}`, `# vercel-orca end ${name}`]
}

const SSH_USER = /^[A-Za-z0-9._-]+$/

function assertSingleLine(field: string, value: string): void {
  if (/[\r\n\0]/.test(value)) throw new UserError(`${field} must be a single line`)
}

// ssh_config splits on whitespace unless the value is double-quoted.
function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : value
}

function render(host: SandboxHost): string {
  assertSingleLine('identityFile', host.identityFile)
  assertSingleLine('proxyCommand', host.proxyCommand)
  if (!SSH_USER.test(host.user)) throw new UserError(`invalid ssh user "${host.user}"`)
  const [begin, end] = markers(host.name)
  return [
    begin,
    `Host ${host.name}`,
    `  User ${host.user}`,
    `  IdentityFile ${quoteIfNeeded(host.identityFile)}`,
    `  ProxyCommand ${host.proxyCommand}`,
    end,
    '',
  ].join('\n')
}

function assertSandboxName(name: string): void {
  if (!SANDBOX_NAME.test(name)) throw new UserError(`invalid sandbox name "${name}"`)
}

function stripBlock(config: string, name: string): string {
  const [begin, end] = markers(name)
  const lines = config.split('\n')
  const from = lines.indexOf(begin)
  const to = lines.indexOf(end, from)
  if (from === -1 || to === -1) return config
  lines.splice(from, to - from + 1)
  return lines.join('\n')
}

// Adds the sandbox's block, replacing one with the same name so re-adding is harmless.
export function addSandboxHost(sshConfigPath: string, host: SandboxHost): void {
  assertSandboxName(host.name)
  mkdirSync(dirname(sshConfigPath), { recursive: true, mode: 0o700 })
  const current = stripBlock(readIfExists(sshConfigPath) ?? '', host.name)
  writeFileSync(sshConfigPath, `${current}${render(host)}`, { mode: 0o600 })
}

export function removeSandboxHost(sshConfigPath: string, name: string): void {
  assertSandboxName(name)
  const current = readIfExists(sshConfigPath)
  if (current === undefined) return
  writeFileSync(sshConfigPath, stripBlock(current, name), { mode: 0o600 })
}

// The sandboxes that have a block in the adapter's ssh_config.
export function listSandboxHosts(sshConfigPath: string): string[] {
  const config = readIfExists(sshConfigPath)
  if (config === undefined) return []
  return config
    .split('\n')
    .filter((line) => line.startsWith(BEGIN_MARKER))
    .map((line) => line.slice(BEGIN_MARKER.length))
}
