import { reasonOf } from './errors.ts'
import type { AdapterHome } from './home.ts'
import { removeKnownHost } from './known-hosts.ts'
import type { Logger } from './logger.ts'
import type { SandboxSession } from './sandbox-session.ts'
import { removeSandboxHost } from './ssh-config.ts'
import { removeKey } from './ssh-keys.ts'

// How long a cancel waits for a sandbox still being created before giving up on deleting it.
const SESSION_WAIT_MS = 10_000

export interface CleanupTarget {
  name: string
  home: AdapterHome
  env: NodeJS.ProcessEnv
  logger: Logger
}

// Removes what `create` leaves behind. Every part runs even if another fails, and the outcome is
// logged by sandbox name. The returned function is safe to call twice: a failure and a signal can
// race, and both then wait for the same cleanup.
export function createCleanup(
  target: CleanupTarget,
  session: () => Promise<SandboxSession | undefined>,
) {
  const { name, home, env, logger } = target
  let running: Promise<void> | undefined

  // A create that never answers must not keep a cancel from cleaning up what is local.
  async function waitForSession(): Promise<SandboxSession | undefined> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        logger.error(
          `create ${name}: the sandbox did not come back in ${SESSION_WAIT_MS}ms and may still need deleting`,
        )
        resolve(undefined)
      }, SESSION_WAIT_MS)
    })
    try {
      return await Promise.race([session(), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  async function clean(): Promise<void> {
    const failed: string[] = []
    async function step(what: string, action: () => unknown): Promise<void> {
      try {
        await action()
      } catch (error) {
        failed.push(what)
        logger.error(`create ${name}: could not remove ${what}: ${reasonOf(error)}`)
      }
    }
    // The sandbox costs money, so it goes first.
    const sandbox = await waitForSession().catch((error: unknown) => {
      logger.error(`create ${name}: no sandbox session to delete: ${reasonOf(error)}`)
      return undefined
    })
    if (sandbox) await step('the sandbox', () => sandbox.delete())
    // The private key next: it is the only sensitive file.
    await step('the private key', () => removeKey(home, name))
    await step('the SSH block', () => removeSandboxHost(home.sshConfig, name))
    await step('the known_hosts entry', () => removeKnownHost(env, name))
    if (failed.length === 0) logger.info(`create ${name}: cleanup done`)
    else logger.error(`create ${name}: cleanup incomplete, still to remove: ${failed.join(', ')}`)
  }

  return function cleanup(): Promise<void> {
    running ??= clean()
    return running
  }
}
