import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { UserError } from './errors.ts'

// Named explicitly because ssh and ssh-keygen would otherwise use the passwd entry's home, not $HOME.
export function knownHostsPath(env: NodeJS.ProcessEnv): string {
  return join(env.HOME || homedir(), '.ssh', 'known_hosts')
}

// ssh's accept-new records the sandbox under its name in the person's known_hosts; drop it again.
// A host that is not there is fine; ssh-keygen only fails when it cannot read the file.
export function removeKnownHost(env: NodeJS.ProcessEnv, name: string): void {
  const result = spawnSync('ssh-keygen', ['-R', name, '-f', knownHostsPath(env)], {
    env,
    encoding: 'utf8',
  })
  const missing = /No such file/.test(result.stderr)
  if (result.error) throw new UserError(`ssh-keygen -R failed: ${result.error.message}`)
  if (result.status !== 0 && !missing) {
    throw new UserError(`ssh-keygen -R failed: ${result.stderr.trim()}`)
  }
}
