import type { Readable, Writable } from 'node:stream'
import { Sandbox } from '@vercel/sandbox'
import type { Command, CommandContext } from './commands.ts'
import type { VercelCredentials } from './credentials.ts'
import { reasonOf, UserError } from './errors.ts'
import { SANDBOX_NAME } from './lifecycle-payload.ts'

// The port the SSH bridge listens on in the sandbox, published at create.
const BRIDGE_PORT = 8080

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
  try {
    const sandbox = await Sandbox.get({ name, ...credentials, fetch: network.fetch })
    return sandbox.domain(BRIDGE_PORT).replace(/^http/, 'ws')
  } catch (error) {
    throw new UserError(`cannot find the SSH bridge of sandbox ${name}: ${reasonOf(error)}`, {
      cause: error,
    })
  }
}

// Copies bytes both ways until either side closes; a socket error rejects.
function pipeThrough(socket: WebSocket, tunnel: Tunnel): Promise<void> {
  socket.binaryType = 'arraybuffer'
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => {
      void (async () => {
        for await (const chunk of tunnel.input) {
          if (socket.readyState !== WebSocket.OPEN) return
          socket.send(chunk as Uint8Array)
        }
        socket.close()
      })().catch(reject)
    })
    socket.addEventListener('message', ({ data }) => {
      if (typeof data === 'string') return reject(new Error('the bridge sent a text message'))
      tunnel.output.write(Buffer.from(data as ArrayBuffer))
    })
    socket.addEventListener('error', () => reject(new Error('the WebSocket connection failed')))
    // An empty write completes once everything before it has reached ssh.
    socket.addEventListener('close', () => tunnel.output.write(Buffer.alloc(0), () => resolve()))
  })
}

async function runProxy({ args, credentials, network, tunnel }: CommandContext): Promise<void> {
  const name = args[0]
  if (!name || !SANDBOX_NAME.test(name)) {
    throw new UserError('usage: vercel-orca proxy <sandbox-name>')
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
