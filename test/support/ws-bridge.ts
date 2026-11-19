import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createConnection, type Socket } from 'node:net'

export interface WsBridge {
  port: number
  // Paths of the WebSocket upgrades received, one per connection.
  connections: string[]
  close(): Promise<void>
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
  return Buffer.concat([header, payload])
}

interface Frame {
  opcode: number
  payload: Buffer
}

// Takes whole client frames (always masked) off the front of `buffer`; the rest is returned.
function parseFrames(buffer: Buffer): { frames: Frame[]; rest: Buffer } {
  const frames: Frame[] = []
  let rest = buffer
  for (;;) {
    if (rest.length < 2) break
    let length = (rest[1] ?? 0) & 0x7f
    let offset = 2
    if (length === 126) {
      if (rest.length < 4) break
      length = rest.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (rest.length < 10) break
      length = Number(rest.readBigUInt64BE(2))
      offset = 10
    }
    if (rest.length < offset + 4 + length) break
    const mask = rest.subarray(offset, offset + 4)
    const payload = Buffer.from(rest.subarray(offset + 4, offset + 4 + length))
    for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0)
    frames.push({ opcode: (rest[0] ?? 0) & 0x0f, payload })
    rest = rest.subarray(offset + 4 + length)
  }
  return { frames, rest }
}

function handshake(request: IncomingMessage, socket: Socket): void {
  const key = String(request.headers['sec-websocket-key'])
  const accept = createHash('sha1')
    .update(key + GUID)
    .digest('base64')
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
}

// A WebSocket server that relays every binary message to a TCP port and back: the offline
// stand-in for websocat in the sandbox. Only what the adapter's client needs is implemented.
export async function startWsBridge(targetPort: number): Promise<WsBridge> {
  const connections: string[] = []
  const sockets = new Set<Socket>()
  const server: Server = createServer((_request, response) => {
    response.writeHead(426).end()
  })
  server.on('upgrade', (request, socket: Socket) => {
    connections.push(request.url ?? '/')
    sockets.add(socket)
    handshake(request, socket)
    const target = createConnection({ host: '127.0.0.1', port: targetPort })
    target.on('data', (chunk) => socket.write(frame(0x2, chunk)))
    target.on('close', () => socket.end(frame(OP_CLOSE, Buffer.alloc(0))))
    target.on('error', () => socket.destroy())
    socket.on('error', () => target.destroy())
    socket.on('close', () => {
      sockets.delete(socket)
      target.destroy()
    })
    let pending: Buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      const parsed = parseFrames(Buffer.concat([pending, chunk]))
      pending = parsed.rest
      for (const { opcode, payload } of parsed.frames) {
        if (opcode === OP_CLOSE) target.end()
        else if (opcode === OP_PING) socket.write(frame(OP_PONG, payload))
        else if (opcode !== OP_PONG) target.write(payload)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    port,
    connections,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
