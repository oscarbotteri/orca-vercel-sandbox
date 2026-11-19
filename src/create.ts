import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { CancelSignal, Command, CommandContext } from './commands.ts'
import { createCleanup } from './create-cleanup.ts'
import { reasonOf, UserError } from './errors.ts'
import { type CheckoutSource, prepareCheckout } from './git-bundle.ts'
import { type AdapterHome, resolveHome } from './home.ts'
import { shellQuote, wrapperPath } from './install.ts'
import { knownHostsPath } from './known-hosts.ts'
import { BRIDGE_PORT } from './lifecycle-payload.ts'
import { checkoutBundle } from './sandbox-checkout.ts'
import type { SandboxSession } from './sandbox-session.ts'
import { installSshBridge, readBridgeLog, readIdentity, startSshBridge } from './sandbox-ssh.ts'
import { addSandboxHost } from './ssh-config.ts'
import { generateKey } from './ssh-keys.ts'

const VERIFY_ATTEMPTS = 6
const VERIFY_DELAY_MS = 500
// 128 plus the signal number, as a shell reports a process killed by it.
const CANCEL_EXIT_CODES: Record<CancelSignal, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }
const CANCEL_SIGNALS = Object.keys(CANCEL_EXIT_CODES) as CancelSignal[]

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

async function provision(
  session: SandboxSession,
  context: CommandContext,
  home: AdapterHome,
  source: CheckoutSource,
): Promise<CreateResult> {
  const { name } = session
  const key = generateKey(home, name)
  const identity = await readIdentity(session)
  await installSshBridge(session, identity, key.publicKey)
  await startSshBridge(session)
  const projectRoot = await checkoutBundle(session, identity, source)
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
    projectRoot,
    userData: { resourceId: name },
  }
}

async function runCreate(context: CommandContext): Promise<void> {
  const { logger, sandboxes, stdout, process } = context
  const home = resolveHome(context.env)
  const name = `orca-${randomBytes(3).toString('hex')}`
  const provider = sandboxes()
  // Bundled before the sandbox exists: a repo Git cannot bundle costs nothing.
  const source = await prepareCheckout(context.env)
  logger.info(`create ${name}: creating the sandbox with port ${BRIDGE_PORT} published`)
  // A signal can arrive before provider.create resolves; cleanup then waits for the session.
  const creating = provider.create({ name, ports: [BRIDGE_PORT] })
  const cleanup = createCleanup({ name, home, env: context.env, logger }, () => creating)
  // `once` on purpose: a second signal gets the default action, so a hung cleanup can be escaped.
  function cancel(signal: CancelSignal): void {
    logger.error(`create ${name}: cancelled by ${signal}`)
    void cleanup().finally(() => process.exit(CANCEL_EXIT_CODES[signal]))
  }
  for (const signal of CANCEL_SIGNALS) process.once(signal, cancel)
  let created = false
  try {
    const session = await creating
    created = true
    const result = await provision(session, context, home, source)
    stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    logger.error(`create ${name}: failed: ${reasonOf(error)}`)
    // Without a sandbox nothing was provisioned: no key, SSH block or known_hosts entry either.
    if (created) await cleanup()
    throw error
  } finally {
    for (const signal of CANCEL_SIGNALS) process.off(signal, cancel)
  }
}

export const createCommand: Command = { readsPayload: false, run: runCreate }
