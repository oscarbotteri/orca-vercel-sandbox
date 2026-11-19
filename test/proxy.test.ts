import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CREDENTIAL_ENV, sandboxBody } from './support/fake-network.ts'
import { type FakeVercelApi, startFakeVercelApi } from './support/fake-vercel-api.ts'
import { type LocalSshd, sshdAvailable, startLocalSshd } from './support/local-sshd.ts'
import { cleanupHomes, runCli } from './support/run-cli.ts'
import { startWsBridge, type WsBridge } from './support/ws-bridge.ts'

const PROXY_PROCESS = join(dirname(fileURLToPath(import.meta.url)), 'support', 'proxy-process.ts')

interface SshResult {
  code: number | null
  stdout: string
  stderr: string
}

function ssh(args: string[], env: NodeJS.ProcessEnv): Promise<SshResult> {
  return new Promise((resolve) => {
    const child = spawn('ssh', args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

afterEach(cleanupHomes)

describe.skipIf(!sshdAvailable())('vercel-orca proxy with ssh', () => {
  let sshd: LocalSshd
  let bridge: WsBridge
  let api: FakeVercelApi

  beforeEach(async () => {
    sshd = await startLocalSshd()
    bridge = await startWsBridge(sshd.port)
    api = await startFakeVercelApi()
    api.on('GET', '/v2/sandboxes/orca-abc123', () => ({ body: sandboxBody('orca-abc123') }))
  })
  afterEach(async () => {
    await api.close()
    await bridge.close()
    await sshd.stop()
  })

  // The sshd fixture's options plus the fixed ProxyCommand Orca's SSH target carries.
  function sshArgs(): string[] {
    const args = sshd.sshArgs()
    const target = args.pop() as string
    return [...args, '-o', `ProxyCommand=node ${PROXY_PROCESS} orca-abc123`, target]
  }

  const env = (): NodeJS.ProcessEnv => ({
    ...process.env,
    ...CREDENTIAL_ENV,
    FAKE_API_URL: api.url,
    FAKE_BRIDGE_PORT: String(bridge.port),
  })

  it('opens an ssh session against the local sshd', async () => {
    const result = await ssh([...sshArgs(), 'echo', 'hello'], env())
    expect(result.stderr).not.toContain('Connection')
    expect(result.stdout.trim()).toBe('hello')
    expect(result.code).toBe(0)
  })

  it('looks the published URL up on every connection, with the token', async () => {
    for (let connection = 1; connection <= 2; connection++) {
      const result = await ssh([...sshArgs(), 'echo', 'hello'], env())
      expect(result.code).toBe(0)
      expect(api.requests).toHaveLength(connection)
    }
    expect(api.requests.map((request) => request.token)).toEqual([
      CREDENTIAL_ENV.VERCEL_TOKEN,
      CREDENTIAL_ENV.VERCEL_TOKEN,
    ])
    expect(bridge.connections).toHaveLength(2)
  })
})

describe('vercel-orca proxy failures', () => {
  let api: FakeVercelApi

  beforeEach(async () => {
    api = await startFakeVercelApi()
  })
  afterEach(async () => {
    await api.close()
  })

  function proxy(name: string, bridgePort = 1) {
    return runCli(['proxy', name], {
      env: CREDENTIAL_ENV,
      network: { apiUrl: api.url, bridgePort },
    })
  }

  function expectNoSecrets(result: { stderr: string; readLog(): string }): void {
    for (const text of [result.stderr, result.readLog()]) {
      expect(text).not.toContain(CREDENTIAL_ENV.VERCEL_TOKEN)
    }
  }

  it('reports a sandbox Vercel does not know on stderr and in the log', async () => {
    const result = await proxy('orca-missing')
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('cannot find the SSH bridge of sandbox orca-missing')
    expect(result.readLog()).toContain('proxy failed')
    expectNoSecrets(result)
  })

  it('reports a bridge that cannot be reached', async () => {
    api.on('GET', '/v2/sandboxes/orca-abc123', () => ({ body: sandboxBody('orca-abc123') }))
    const result = await proxy('orca-abc123')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('connection to sandbox orca-abc123 failed')
    expectNoSecrets(result)
  })

  it('reports an API error that echoes the token without repeating it', async () => {
    api.on('GET', '/v2/sandboxes/orca-abc123', (request) => ({
      status: 403,
      body: { error: { code: 'forbidden', message: `bad token ${request.token}` } },
    }))
    const result = await proxy('orca-abc123')
    expect(result.code).toBe(1)
    expectNoSecrets(result)
  })

  it('refuses a missing or malformed sandbox name before any API call', async () => {
    for (const name of ['', '-bad name']) {
      const result = await proxy(name)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('usage: vercel-orca proxy <sandbox-name>')
    }
    expect(api.requests).toHaveLength(0)
  })

  it('needs the Vercel credentials', async () => {
    const result = await runCli(['proxy', 'orca-abc123'], {
      env: { VERCEL_TOKEN: '', VERCEL_TEAM_ID: '', VERCEL_PROJECT_ID: '' },
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('VERCEL_TOKEN is not set')
  })
})
