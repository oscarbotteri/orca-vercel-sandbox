import type { Network } from '../../src/main.ts'

export const CREDENTIAL_ENV = {
  VERCEL_TOKEN: 'vca_fakefakefakefakefake',
  VERCEL_TEAM_ID: 'team_fake',
  VERCEL_PROJECT_ID: 'prj_fake',
}

// The body `GET /v2/sandboxes/<name>` answers: a running sandbox with port 8080 published.
export function sandboxBody(name: string, subdomain = 'sb-fake'): unknown {
  return {
    sandbox: {
      name,
      persistent: true,
      createdAt: 1,
      updatedAt: 1,
      currentSessionId: 'sbx_session',
      status: 'running',
    },
    session: {
      id: 'sbx_session',
      memory: 2048,
      vcpus: 1,
      region: 'iad1',
      timeout: 300000,
      status: 'running',
      requestedAt: 1,
      createdAt: 1,
      cwd: '/vercel',
      updatedAt: 1,
    },
    routes: [{ url: `https://${subdomain}.vercel.run`, subdomain, port: 8080 }],
  }
}

// The adapter's network with api.vercel.com and the published URL redirected to local servers.
export function fakeNetwork(apiUrl: string, bridgePort: number): Network {
  return {
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      return fetch(`${apiUrl}${url.pathname}${url.search}`, init)
    },
    webSocket: (url) => {
      const { pathname, search } = new URL(url)
      return new WebSocket(`ws://127.0.0.1:${bridgePort}${pathname}${search}`)
    },
  }
}
