import type { Readable, Writable } from 'node:stream'
import { Sandbox } from '@vercel/sandbox'
import { isAsleep } from './asleep.ts'
import type { Command, CommandContext } from './commands.ts'
import type { VercelCredentials } from './credentials.ts'
import { reasonOf, UserError } from './errors.ts'
import { resolveHome } from './home.ts'
import { BRIDGE_PORT, SANDBOX_NAME } from './lifecycle-payload.ts'

export interface Network {
  fetch: typeof globalThis.fetch
  webSocket(url: string): WebSocket
}

// The two ends of the connection ssh holds: what it sends, and what it receives.
export interface Tunnel {
  input: Readable
  output: Writable
}

// Looked up on every connection and never kept: the SSH target Orca stores must not hold a URL.
async function bridgeUrl(
  name: string,
  credentials: VercelCredentials,
  network: Network,
): Promise<string> {
  let sandbox: Sandbox
  try {
    sandbox = await Sandbox.get({ name, ...credentials, fetch: network.fetch })
  } catch (error) {
    throw new UserError(`cannot look up sandbox ${name} on Vercel: ${reasonOf(error)}`, {
      cause: error,
    })
  }
  try {
    return sandbox.domain(BRIDGE_PORT).replace(/^http/, 'ws')
  } catch (error) {
    throw new UserError(`sandbox ${name} publishes no SSH bridge port (${BRIDGE_PORT})`, {
      cause: error,
    })
  }
}

export interface PipeLimits {
  // The bridge must answer the upgrade within this time; ssh's ConnectTimeout does not cover a silent ProxyCommand.
  openTimeoutMs: number
  // Stop reading ssh's input while the socket holds more unsent bytes than this.
  sendHighWater: number
  // The native WebSocket cannot pause, so a reader this far behind ends the connection.
  receiveHighWater: number
}

const MiB = 1024 * 1024
const DEFAULT_LIMITS: PipeLimits = {
  openTimeoutMs: 20_000,
  sendHighWater: MiB,
  receiveHighWater: 16 * MiB,
}
const DRAIN_POLL_MS = 10
// A local close after stdin EOF gives one of these; any other code means the bridge failed.
const CLEAN_CLOSE_CODES = [1000, 1005]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Reads ssh's input into the socket, pausing while the socket's send buffer is full.
async function sendInput(socket: WebSocket, input: Readable, limits: PipeLimits): Promise<void> {
  for await (const chunk of input) {
    while (socket.readyState === WebSocket.OPEN && socket.bufferedAmount > limits.sendHighWater) {
      await sleep(DRAIN_POLL_MS)
    }
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(chunk as Uint8Array)
  }
  socket.close()
}

// Writes a bridge message to ssh; returns why the pipe must end, if it must (the native WebSocket cannot pause).
function relay(data: unknown, output: Writable, limits: PipeLimits): Error | undefined {
  if (typeof data === 'string') return new Error('the bridge sent a text message')
  output.write(Buffer.from(data as ArrayBuffer))
  if (output.writableLength > limits.receiveHighWater) {
    return new Error('ssh is not reading fast enough')
  }
}

// Copies bytes both ways until either side closes; a socket error or an abnormal close rejects.
export function pipeThrough(
  socket: WebSocket,
  tunnel: Tunnel,
  limits: PipeLimits = DEFAULT_LIMITS,
): Promise<void> {
  socket.binaryType = 'arraybuffer'
  return new Promise((resolve, reject) => {
    let done = false
    // The first ending wins: it stops the open timer and closes the socket.
    function settle(error?: Error): void {
      if (done) return
      done = true
      clearTimeout(openTimer)
      if (socket.readyState < WebSocket.CLOSING) socket.close()
      if (error) reject(error)
      else resolve()
    }
    const openTimer = setTimeout(
      () => settle(new Error(`the bridge did not open within ${limits.openTimeoutMs / 1000}s`)),
      limits.openTimeoutMs,
    )
    socket.addEventListener('open', () => {
      clearTimeout(openTimer)
      sendInput(socket, tunnel.input, limits).catch(settle)
    })
    socket.addEventListener('message', ({ data }) => {
      if (done) return
      const error = relay(data, tunnel.output, limits)
      if (error) settle(error)
    })
    // ssh closing its end while the bridge still sends would otherwise crash on EPIPE.
    tunnel.output.on('error', settle)
    socket.addEventListener('error', () => settle(new Error('the WebSocket connection failed')))
    socket.addEventListener('close', (event) => {
      if (done) return
      const { code } = event as CloseEvent
      if (!CLEAN_CLOSE_CODES.includes(code)) {
        return settle(new Error(`the bridge closed with code ${code}`))
      }
      // An empty write completes once everything before it has reached ssh.
      tunnel.output.write(Buffer.alloc(0), (error) => settle(error ?? undefined))
    })
  })
}

async function runProxy({
  args,
  credentials,
  env,
  network,
  tunnel,
}: CommandContext): Promise<void> {
  const name = args[0]
  if (!name || !SANDBOX_NAME.test(name)) {
    throw new UserError('usage: vercel-orca proxy <sandbox-name>')
  }
  if (isAsleep(resolveHome(env), name)) {
    throw new UserError(`sandbox ${name} is asleep; wake the workspace in Orca to connect`)
  }
  const url = await bridgeUrl(name, credentials(), network)
  try {
    await pipeThrough(network.webSocket(url), tunnel)
  } catch (error) {
    throw new UserError(`connection to sandbox ${name} failed: ${reasonOf(error)}`, {
      cause: error,
    })
  } finally {
    // ssh closing its end must not keep this process alive waiting on stdin.
    tunnel.input.destroy()
  }
}

export const proxyCommand: Command = { readsPayload: false, run: runProxy }
