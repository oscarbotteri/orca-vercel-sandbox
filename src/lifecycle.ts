import { clearAsleep, isAsleep, markAsleep } from './asleep.ts'
import type { Command, CommandContext } from './commands.ts'
import { UserError } from './errors.ts'
import { resolveHome } from './home.ts'
import { startSshBridge } from './sandbox-ssh.ts'
import { verifySshWithBridgeLog } from './ssh-verify.ts'

export function sandboxName({ payload }: CommandContext): string {
  if (!payload) throw new UserError('vercel-orca needs the lifecycle payload on stdin')
  return payload.sandbox
}

// Marks first, so a reconnect during the stop cannot wake the sandbox again.
async function runSuspend(context: CommandContext): Promise<void> {
  const name = sandboxName(context)
  const home = resolveHome(context.env)
  const wasAsleep = isAsleep(home, name)
  markAsleep(home, name)
  try {
    await (await context.sandboxes().get(name)).stop()
  } catch (error) {
    // A failed retry must not wake a workspace an earlier suspend already put to sleep.
    if (!wasAsleep) clearAsleep(home, name)
    throw error
  }
}

// The mark is cleared once the bridge runs and before the SSH check, which goes through `proxy`.
async function runResume(context: CommandContext): Promise<void> {
  const name = sandboxName(context)
  const home = resolveHome(context.env)
  const session = await context.sandboxes().get(name, { resume: true })
  await startSshBridge(session)
  clearAsleep(home, name)
  context.logger.info(`resume ${name}: bridge started, checking SSH`)
  await verifySshWithBridgeLog(session, home, context.env)
}

export const suspendCommand: Command = { readsPayload: true, run: runSuspend }
export const resumeCommand: Command = { readsPayload: true, run: runResume }
