import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { keepAlive } from '../src/keep-alive.ts'
import type { Logger } from '../src/logger.ts'
import type { SandboxSession } from '../src/sandbox-session.ts'

function session(extendTimeout: (ms: number) => Promise<void>): SandboxSession {
  return { name: 'orca-abc123', extendTimeout } as unknown as SandboxSession
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('keepAlive', () => {
  it('adds the elapsed interval to the timeout on every tick until stopped', () => {
    const extend = vi.fn(async () => {})
    const stop = keepAlive(session(extend), { info: vi.fn(), error: vi.fn() }, 1000)
    vi.advanceTimersByTime(2500)
    expect(extend.mock.calls).toEqual([[1000], [1000]])
    stop()
    vi.advanceTimersByTime(5000)
    expect(extend).toHaveBeenCalledTimes(2)
  })

  it('logs a failed extension and keeps trying', async () => {
    const extend = vi.fn(async () => {
      throw new Error('plan maximum reached')
    })
    const logger: Logger = { info: vi.fn(), error: vi.fn() }
    const stop = keepAlive(session(extend), logger, 1000)
    await vi.advanceTimersByTimeAsync(2000)
    stop()
    expect(extend).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalledWith(
      'keep-alive orca-abc123: cannot extend the timeout: plan maximum reached',
    )
  })
})
