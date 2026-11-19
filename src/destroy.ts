import { clearAsleep } from './asleep.ts'
import type { Command, CommandContext } from './commands.ts'
import { reasonOf, UserError } from './errors.ts'
import { resolveHome } from './home.ts'
import { removeKnownHost } from './known-hosts.ts'
import { sandboxName } from './lifecycle.ts'
import { saveUnpushedWork } from './sandbox-save.ts'
import { readSandboxState, removeSandboxState } from './sandbox-state.ts'
import { removeSandboxHost } from './ssh-config.ts'
import { removeKey } from './ssh-keys.ts'

// Wakes the sandbox, saves its unpushed work locally, and only then deletes it. A sandbox that
// cannot be saved stays, with its key and SSH block, so the next destroy can try again.
async function runDestroy(context: CommandContext): Promise<void> {
  const name = sandboxName(context)
  const { logger, env } = context
  const home = resolveHome(env)
  const state = readSandboxState(home, name)
  const session = await context.sandboxes().get(name, { resume: true })
  const saved = await saveUnpushedWork(session, state, name, env)
  logger.info(`destroy ${name}: saved ${saved.length} piece(s) of unpushed work`)
  await session.delete()

  const failed: string[] = []
  function step(what: string, action: () => unknown): void {
    try {
      action()
    } catch (error) {
      failed.push(what)
      logger.error(`destroy ${name}: could not remove ${what}: ${reasonOf(error)}`)
    }
  }
  step('the private key', () => removeKey(home, name))
  step('the SSH block', () => removeSandboxHost(home.sshConfig, name))
  step('the state', () => {
    clearAsleep(home, name)
    removeSandboxState(home, name)
  })
  // The sandbox is gone already: a known_hosts entry left behind is harmless.
  try {
    removeKnownHost(env, name)
  } catch (error) {
    logger.error(`destroy ${name}: could not remove the known_hosts entry: ${reasonOf(error)}`)
  }
  if (failed.length > 0) {
    throw new UserError(
      `sandbox ${name} is deleted but still to remove locally: ${failed.join(', ')}`,
    )
  }
}

export const destroyCommand: Command = { readsPayload: true, run: runDestroy }
