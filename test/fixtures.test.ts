import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { type FakeVercelApi, startFakeVercelApi } from './support/fake-vercel-api.ts'
import { type LocalSshd, sshdAvailable, startLocalSshd } from './support/local-sshd.ts'

describe('fake Vercel API', () => {
  let api: FakeVercelApi | undefined
  afterEach(async () => {
    await api?.close()
    api = undefined
  })

  it('serves registered routes and records every request, with its bearer token', async () => {
    api = await startFakeVercelApi()
    api.on('POST', '/v1/sandboxes', (request) => ({
      status: 201,
      body: { name: 'orca-fake1', echoed: request.body },
    }))

    const response = await fetch(`${api.url}/v1/sandboxes`, {
      method: 'POST',
      headers: { authorization: 'Bearer fake-token', 'content-type': 'application/json' },
      body: JSON.stringify({ ports: [8080] }),
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ name: 'orca-fake1', echoed: { ports: [8080] } })
    expect(api.requests).toEqual([
      { method: 'POST', path: '/v1/sandboxes', token: 'fake-token', body: { ports: [8080] } },
    ])
  })

  it('answers 404 with a JSON error for a route nobody registered', async () => {
    api = await startFakeVercelApi()
    const response = await fetch(`${api.url}/v1/nothing`)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: { code: 'not_found' } })
    expect(api.requests).toHaveLength(1)
  })
})

describe.skipIf(!sshdAvailable())('local sshd', () => {
  let sshd: LocalSshd | undefined
  afterEach(async () => {
    await sshd?.stop()
    sshd = undefined
  })

  it('accepts the generated key and refuses everything else', async () => {
    sshd = await startLocalSshd()
    const withKey = spawnSync('ssh', [...sshd.sshArgs(), 'echo', 'hello'], { encoding: 'utf8' })
    expect(withKey.stdout.trim()).toBe('hello')

    const unknownKey = spawnSync('ssh', [...sshd.sshArgs(sshd.strangerKey), 'echo', 'hello'], {
      encoding: 'utf8',
    })
    expect(unknownKey.status).not.toBe(0)
    expect(unknownKey.stdout).toBe('')
  })
})
