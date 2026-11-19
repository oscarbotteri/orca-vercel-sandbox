import { chmodSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AdapterHome {
  root: string
  bin: string
  keys: string
  state: string
  config: string
  sshConfig: string
  lifecycleLog: string
}

export function resolveHome(env: NodeJS.ProcessEnv): AdapterHome {
  const root = env.VERCEL_ORCA_HOME || join(homedir(), '.vercel-orca')
  return {
    root,
    bin: join(root, 'bin'),
    keys: join(root, 'keys'),
    state: join(root, 'state'),
    config: join(root, 'config.json'),
    sshConfig: join(root, 'ssh_config'),
    lifecycleLog: join(root, 'lifecycle.log'),
  }
}

export function ensureHome(home: AdapterHome): void {
  for (const dir of [home.root, home.bin, home.keys, home.state]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // mkdir's mode only applies to directories it creates, and the umask can narrow it.
    chmodSync(dir, 0o700)
  }
}
