import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { Command, CommandContext } from './commands.ts'
import { reasonOf, UserError } from './errors.ts'
import { type AdapterHome, resolveHome } from './home.ts'
import { shellQuote, wrapperPath } from './install.ts'
import { BRIDGE_PORT } from './lifecycle-payload.ts'
import type { SandboxSession } from './sandbox-session.ts'
import { installSshBridge, readBridgeLog, readIdentity, startSshBridge } from './sandbox-ssh.ts'
import { addSandboxHost, removeSandboxHost } from './ssh-config.ts'
import { generateKey, removeKey } from './ssh-keys.ts'

const VERIFY_ATTEMPTS = 6
const VERIFY_DELAY_MS = 500

interface CreateResult {
  sshTarget: { host: string; port: number; username: string; proxyCommand: string }
  projectRoot: string
  userData: { resourceId: string }
}

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

async function provision(
  session: SandboxSession,
  context: CommandContext,
  home: AdapterHome,
): Promise<CreateResult> {
  const { name } = session
  const key = generateKey(home, name)
  const identity = await readIdentity(session)
  await installSshBridge(session, identity, key.publicKey)
  await startSshBridge(session)
  const proxyCommand = `${shellQuote(wrapperPath(home))} proxy ${name}`
  addSandboxHost(home.sshConfig, {
    name,
    user: identity.user,
    identityFile: key.privatePath,
    proxyCommand,
  })
  try {
    await verifySsh(home, name, context.env)
  } catch (error) {
    const bridge = await readBridgeLog(session).catch(() => '')
    if (!bridge) throw error
    throw new UserError(`${reasonOf(error)}; the bridge said:\n${bridge}`, { cause: error })
  }
  return {
    sshTarget: { host: name, port: 22, username: identity.user, proxyCommand },
    projectRoot: `${identity.home}/work`,
    userData: { resourceId: name },
  }
}

async function runCreate(context: CommandContext): Promise<void> {
  const { logger, sandboxes, stdout } = context
  const home = resolveHome(context.env)
  const name = `orca-${randomBytes(3).toString('hex')}`
  const provider = sandboxes()
  logger.info(`create ${name}: creating the sandbox with port ${BRIDGE_PORT} published`)
  const session = await provider.create({ name, ports: [BRIDGE_PORT] })
  try {
    const result = await provision(session, context, home)
    stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    logger.error(`create ${name}: removing the sandbox after: ${reasonOf(error)}`)
    // The sandbox costs money, so it goes first and a failing local cleanup cannot stop it.
    await session.delete().catch((deleteError: unknown) => {
      logger.error(`create ${name}: could not delete the sandbox: ${reasonOf(deleteError)}`)
    })
    try {
      // The private key first: it is the only sensitive file.
      removeKey(home, name)
      removeSandboxHost(home.sshConfig, name)
    } catch (cleanupError) {
      logger.error(`create ${name}: could not remove local files: ${reasonOf(cleanupError)}`)
    }
    throw error
  }
}

export const createCommand: Command = { readsPayload: false, run: runCreate }
