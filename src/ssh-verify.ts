import { spawn } from 'node:child_process'
import { reasonOf, UserError } from './errors.ts'
import type { AdapterHome } from './home.ts'
import { knownHostsPath } from './known-hosts.ts'
import type { SandboxSession } from './sandbox-session.ts'
import { readBridgeLog } from './sandbox-ssh.ts'

const VERIFY_ATTEMPTS = 6
const VERIFY_DELAY_MS = 500

function sshAttempt(home: AdapterHome, name: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    // accept-new records the sandbox's host key on first contact and refuses a changed one.
    const child = spawn(
      'ssh',
      [
        '-F',
        home.sshConfig,
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        `UserKnownHostsFile=${knownHostsPath(env)}`,
        '-o',
        'ConnectTimeout=20',
        name,
        'true',
      ],
      { env, stdio: 'ignore' },
    )
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

// sshd and the bridge may need a moment after they start, so the first tries can fail.
async function verifySsh(home: AdapterHome, name: string, env: NodeJS.ProcessEnv): Promise<void> {
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
    if (await sshAttempt(home, name, env)) return
    if (attempt < VERIFY_ATTEMPTS) await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS))
  }
  throw new UserError(`the SSH connection to sandbox ${name} could not be verified`)
}

// A failed check carries what the bridge said, which usually explains why it never came up.
export async function verifySshWithBridgeLog(
  session: SandboxSession,
  home: AdapterHome,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    await verifySsh(home, session.name, env)
  } catch (error) {
    const bridge = await readBridgeLog(session).catch(() => '')
    if (!bridge) throw error
    throw new UserError(`${reasonOf(error)}; the bridge said:\n${bridge}`, { cause: error })
  }
}
