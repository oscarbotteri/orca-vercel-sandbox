import { spawnSync } from 'node:child_process'
import { resolveCredentials } from './credentials.ts'
import { UserError } from './errors.ts'

const MIN_NODE_MAJOR = 24

function runs(command: string, args: string[], env: NodeJS.ProcessEnv): boolean {
  return spawnSync(command, args, { env, stdio: 'ignore' }).status === 0
}

export function findMissingPrerequisites(env: NodeJS.ProcessEnv): string[] {
  const missing: string[] = []
  const major = Number(process.versions.node.split('.')[0])
  if (major < MIN_NODE_MAJOR) {
    missing.push(`Node ${MIN_NODE_MAJOR} or newer (found ${process.versions.node})`)
  }
  if (!runs('git', ['--version'], env)) missing.push('Git (`git` not found on PATH)')
  if (!runs('ssh', ['-V'], env)) missing.push('OpenSSH (`ssh` not found on PATH)')
  try {
    resolveCredentials(env)
  } catch (error) {
    if (!(error instanceof UserError)) throw error
    missing.push(error.message)
  }
  return missing
}

export function assertPrerequisites(env: NodeJS.ProcessEnv): void {
  const missing = findMissingPrerequisites(env)
  if (missing.length > 0) {
    throw new UserError(`setup cannot continue, missing:\n- ${missing.join('\n- ')}`)
  }
}
