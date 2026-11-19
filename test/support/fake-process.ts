import type { ProcessControl } from '../../src/main.ts'

export interface FakeProcess extends ProcessControl {
  exitCodes: number[]
  // Resolves on the first exit the code under test asks for.
  exited: Promise<void>
  raise(signal: NodeJS.Signals): void
}

export function fakeProcess(): FakeProcess {
  const listeners = new Map<string, () => void>()
  let resolveExit: () => void = () => {}
  const fake: FakeProcess = {
    exitCodes: [],
    exited: new Promise((resolve) => {
      resolveExit = resolve
    }),
    once(signal, listener) {
      listeners.set(signal, listener)
    },
    off(signal, listener) {
      if (listeners.get(signal) === listener) listeners.delete(signal)
    },
    exit(code) {
      fake.exitCodes.push(code)
      resolveExit()
    },
    raise(signal) {
      const listener = listeners.get(signal)
      listeners.delete(signal)
      listener?.()
    },
  }
  return fake
}
