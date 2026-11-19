import { reasonOf } from './errors.ts'
import type { Logger } from './logger.ts'
import type { SandboxSession } from './sandbox-session.ts'

// Vercel stops a sandbox when its timeout runs out, so each tick adds back the time that passed.
export const KEEP_ALIVE_MS = 60_000

// Extends the sandbox timeout while a connection is open; returns what stops it.
// A failed extension (plan maximum reached, API down) is logged and does not end the connection.
export function keepAlive(
  session: SandboxSession,
  logger: Logger,
  intervalMs: number = KEEP_ALIVE_MS,
): () => void {
  const timer = setInterval(() => {
    session.extendTimeout(intervalMs).catch((error: unknown) => {
      logger.error(`keep-alive ${session.name}: cannot extend the timeout: ${reasonOf(error)}`)
    })
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
