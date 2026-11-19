import { spawn } from 'node:child_process'
import { reasonOf, UserError } from './errors.ts'
import type { AdapterHome } from './home.ts'
import { knownHostsPath } from './known-hosts.ts'
import type { SandboxSession } from './sandbox-session.ts'
import { readBridgeLog } from './sandbox-ssh.ts'

const VERIFY_ATTEMPTS = 6
const VERIFY_DELAY_MS = 500

interface Attempt {
  ok: boolean
  // What ssh and its ProxyCommand wrote to stderr, which says why a connection failed.
  stderr: string
}

function sshAttempt(home: AdapterHome, name: string, env: NodeJS.ProcessEnv): Promise<Attempt> {
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
      { env, stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk
    })
    child.on('error', (error) => resolve({ ok: false, stderr: error.message }))
    child.on('close', (code) => resolve({ ok: code === 0, stderr: stderr.trim() }))
  })
}

// sshd and the bridge may need a moment after they start, so the first tries can fail.
async function verifySsh(home: AdapterHome, name: string, env: NodeJS.ProcessEnv): Promise<void> {
  let last = ''
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
    const result = await sshAttempt(home, name, env)
    if (result.ok) return
    last = result.stderr
    if (attempt < VERIFY_ATTEMPTS) await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS))
  }
  throw new UserError(
    `the SSH connection to sandbox ${name} could not be verified` +
      (last ? `; ssh said:\n${last}` : ''),
  )
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
