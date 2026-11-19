import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface RecordedRequest {
  method: string
  path: string
  token: string | undefined
  body: unknown
}

export interface FakeResponse {
  status?: number
  body?: unknown
}

export type FakeHandler = (request: RecordedRequest) => FakeResponse | Promise<FakeResponse>

export interface FakeVercelApi {
  url: string
  requests: RecordedRequest[]
  on(method: string, path: string, handler: FakeHandler): void
  close(): Promise<void>
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function bearer(header: string | undefined): string | undefined {
  return header?.match(/^Bearer (.+)$/i)?.[1]
}

// A local HTTP server that stands in for api.vercel.com: tests register the routes a flow needs
// and read back what the adapter sent. Unregistered routes answer 404 so a stray call is loud.
export async function startFakeVercelApi(): Promise<FakeVercelApi> {
  const handlers = new Map<string, FakeHandler>()
  const requests: RecordedRequest[] = []

  const server: Server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://fake').pathname
    const recorded: RecordedRequest = {
      method: request.method ?? 'GET',
      path,
      token: bearer(request.headers.authorization),
      body: await readBody(request),
    }
    requests.push(recorded)
    const handler = handlers.get(`${recorded.method} ${path}`)
    const { status = 200, body } = handler
      ? await handler(recorded)
      : { status: 404, body: { error: { code: 'not_found' } } }
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body ?? {}))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    on: (method, path, handler) => void handlers.set(`${method.toUpperCase()} ${path}`, handler),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
