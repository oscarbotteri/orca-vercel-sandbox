import { PassThrough, type Readable, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PipeLimits, pipeThrough } from '../src/proxy.ts'

// A WebSocket the test drives by hand: it records what is sent and lets the test raise events.
class FakeSocket extends EventTarget {
  binaryType = 'blob'
  readyState = 0
  bufferedAmount = 0
  sent: Uint8Array[] = []
  closed: { code?: number; reason?: string } | undefined

  send(data: Uint8Array): void {
    this.sent.push(data)
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
    this.readyState = 3
  }
  open(): void {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }
  message(data: unknown): void {
    this.dispatchEvent(Object.assign(new Event('message'), { data }))
  }
  closeWith(code: number): void {
    this.readyState = 3
    this.dispatchEvent(Object.assign(new Event('close'), { code }))
  }
}

const LIMITS: PipeLimits = {
  openTimeoutMs: 1000,
  keepAliveMs: 100,
  sendHighWater: 10,
  receiveHighWater: 10,
}

function pipe(socket: FakeSocket, input: Readable = new PassThrough(), output?: Writable) {
  const tunnel = { input, output: output ?? new PassThrough() }
  return pipeThrough(socket as unknown as WebSocket, tunnel, LIMITS)
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('pipeThrough close codes', () => {
  it.each([1000, 1005])('resolves on code %i', async (code) => {
    const socket = new FakeSocket()
    const done = pipe(socket)
    socket.open()
    socket.closeWith(code)
    await expect(done).resolves.toBeUndefined()
  })

  it.each([1001, 1008, 1011])('rejects on error code %i', async (code) => {
    const socket = new FakeSocket()
    const done = pipe(socket)
    const assertion = expect(done).rejects.toThrow(`closed with code ${code}`)
    socket.open()
    socket.closeWith(code)
    await assertion
  })
})

describe('pipeThrough open timeout', () => {
  it('rejects and closes a socket that never opens', async () => {
    const socket = new FakeSocket()
    const done = pipe(socket)
    const assertion = expect(done).rejects.toThrow('did not open within 1s')
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    expect(socket.closed).toBeDefined()
  })

  it('does not time out once open', async () => {
    const socket = new FakeSocket()
    const done = pipe(socket)
    socket.open()
    await vi.advanceTimersByTimeAsync(5000)
    expect(socket.closed).toBeUndefined()
    socket.closeWith(1000)
    await done
  })
})

describe('pipeThrough keep-alive', () => {
  it('sends an empty message while idle and stops after close', async () => {
    const socket = new FakeSocket()
    const done = pipe(socket)
    socket.open()
    await vi.advanceTimersByTimeAsync(250)
    expect(socket.sent.map((chunk) => chunk.length)).toEqual([0, 0])
    socket.closeWith(1000)
    await done
    await vi.advanceTimersByTimeAsync(500)
    expect(socket.sent).toHaveLength(2)
  })
})

describe('pipeThrough sending backpressure', () => {
  it('waits for bufferedAmount to drain before sending the next chunk', async () => {
    vi.useRealTimers()
    const socket = new FakeSocket()
    const input = new PassThrough()
    const done = pipe(socket, input)
    socket.open()
    input.write(Buffer.from('a'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    socket.bufferedAmount = 50
    input.write(Buffer.from('b'))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(socket.sent.filter((chunk) => chunk.length > 0)).toHaveLength(1)
    socket.bufferedAmount = 0
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(socket.sent.filter((chunk) => chunk.length > 0)).toHaveLength(2)
    socket.closeWith(1000)
    await done
  })
})

describe('pipeThrough receiving backpressure', () => {
  it('rejects when ssh falls too far behind', async () => {
    const socket = new FakeSocket()
    const output = new Writable({ highWaterMark: 1, write() {} })
    const done = pipe(socket, new PassThrough(), output)
    const assertion = expect(done).rejects.toThrow('ssh is not reading fast enough')
    socket.open()
    socket.message(new ArrayBuffer(6))
    socket.message(new ArrayBuffer(6))
    await assertion
    expect(socket.closed).toBeDefined()
  })

  it('copies data to the output while it keeps up', async () => {
    const socket = new FakeSocket()
    const output = new PassThrough()
    const done = pipe(socket, new PassThrough(), output)
    socket.open()
    socket.message(new TextEncoder().encode('hi').buffer)
    expect(output.read().toString()).toBe('hi')
    socket.closeWith(1000)
    await done
  })
})

describe('pipeThrough failures', () => {
  it('rejects on a text message, closes the socket and stops the keep-alive', async () => {
    const socket = new FakeSocket()
    const done = pipe(socket)
    const assertion = expect(done).rejects.toThrow('the bridge sent a text message')
    socket.open()
    socket.message('hello')
    await assertion
    expect(socket.closed).toBeDefined()
    await vi.advanceTimersByTimeAsync(500)
    expect(socket.sent).toHaveLength(0)
  })

  it('rejects on a socket error', async () => {
    const socket = new FakeSocket()
    const done = pipe(socket)
    const assertion = expect(done).rejects.toThrow('the WebSocket connection failed')
    socket.dispatchEvent(new Event('error'))
    await assertion
  })

  it('rejects when the output fails', async () => {
    const socket = new FakeSocket()
    const output = new PassThrough()
    const done = pipe(socket, new PassThrough(), output)
    const assertion = expect(done).rejects.toThrow('write EPIPE')
    output.emit('error', new Error('write EPIPE'))
    await assertion
  })

  it('rejects when the input fails', async () => {
    const socket = new FakeSocket()
    const input = new PassThrough()
    const done = pipe(socket, input)
    const assertion = expect(done).rejects.toThrow('input broke')
    socket.open()
    input.destroy(new Error('input broke'))
    await assertion
  })

  it('stays quiet while data keeps flowing', async () => {
    const socket = new FakeSocket()
    const input = new PassThrough()
    const done = pipe(socket, input)
    socket.open()
    for (let tick = 0; tick < 4; tick++) {
      await vi.advanceTimersByTimeAsync(60)
      input.write(Buffer.from('x'))
    }
    expect(socket.sent.every((chunk) => chunk.length > 0)).toBe(true)
    socket.closeWith(1000)
    await done
  })
})
