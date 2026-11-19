import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SandboxProvider, SandboxSummary } from '../src/sandbox-session.ts'
import { addSandboxHost, includeLine } from '../src/ssh-config.ts'
import { CREDENTIAL_ENV } from './support/fake-network.ts'
import { startFakeVercelApi } from './support/fake-vercel-api.ts'
import { cleanupHomes, runCli } from './support/run-cli.ts'

afterEach(cleanupHomes)

function provider(listed: SandboxSummary[] | Error): SandboxProvider & { calls: string[] } {
  const calls: string[] = []
  const refuse = async (): Promise<never> => {
    throw new Error('doctor and list must not touch a sandbox')
  }
  return {
    calls,
    async list() {
      calls.push('list')
      if (listed instanceof Error) throw listed
      return listed
    },
    create: refuse,
    get: refuse,
  }
}

// A sandbox as `create` leaves it: SSH block, key and workspace record.
function seedWorkspace(userHome: string, name: string, label: string, keyMode = 0o600): void {
  const home = join(userHome, '.vercel-orca')
  for (const dir of ['keys', 'state']) mkdirSync(join(home, dir), { recursive: true })
  writeFileSync(join(home, 'keys', name), 'key', { mode: keyMode })
  chmodSync(join(home, 'keys', name), keyMode)
  writeFileSync(join(home, 'state', `${name}.workspace`), `${label}\n`)
  addSandboxHost(join(home, 'ssh_config'), {
    name,
    user: 'ubuntu',
    identityFile: join(home, 'keys', name),
    proxyCommand: 'proxy',
  })
}

// A machine `setup` finished on: wrapper installed and the Include line in place.
function seedInstall(userHome: string): void {
  const home = join(userHome, '.vercel-orca')
  mkdirSync(join(home, 'bin'), { recursive: true })
  writeFileSync(join(home, 'bin', 'vercel-orca'), '#!/bin/sh\n')
  mkdirSync(join(userHome, '.ssh'), { recursive: true })
  writeFileSync(join(userHome, '.ssh', 'config'), `${includeLine(join(home, 'ssh_config'))}\n`)
}

describe('vercel-orca list', () => {
  it('shows name, state and workspace for each sandbox', async () => {
    const sandboxes = provider([
      { name: 'orca-aaa111', status: 'running' },
      { name: 'orca-bbb222', status: 'stopped' },
    ])
    const result = await runCli(['list'], {
      env: CREDENTIAL_ENV,
      sandboxes,
      beforeRun(userHome) {
        seedWorkspace(userHome, 'orca-aaa111', 'app (main)')
        seedWorkspace(userHome, 'orca-bbb222', 'app (feature)')
        writeFileSync(join(userHome, '.vercel-orca', 'state', 'orca-bbb222.asleep'), '')
      },
    })
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(/orca-aaa111\s+running\s+app \(main\)/)
    expect(result.stderr).toMatch(/orca-bbb222\s+asleep\s+app \(feature\)/)
  })

  it('marks a sandbox no workspace uses as an orphan', async () => {
    const result = await runCli(['list'], {
      env: CREDENTIAL_ENV,
      sandboxes: provider([{ name: 'orca-ccc333', status: 'running' }]),
    })
    expect(result.stderr).toMatch(/orca-ccc333\s+running\s+\(none: orphan\)/)
  })

  it('says so when there are no sandboxes, and keeps workspaces out of the log', async () => {
    const empty = await runCli(['list'], { env: CREDENTIAL_ENV, sandboxes: provider([]) })
    expect(empty.stderr).toContain('no sandboxes')
    const listed = await runCli(['list'], {
      env: CREDENTIAL_ENV,
      sandboxes: provider([{ name: 'orca-aaa111', status: 'running' }]),
      beforeRun: (userHome) => seedWorkspace(userHome, 'orca-aaa111', 'secret-repo (main)'),
    })
    expect(listed.readLog()).not.toContain('secret-repo')
  })

  it('fails with the reason when Vercel cannot be listed', async () => {
    const result = await runCli(['list'], {
      env: CREDENTIAL_ENV,
      sandboxes: provider(new Error('cannot list sandboxes on Vercel: boom')),
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('boom')
  })
})

describe('vercel-orca doctor', () => {
  async function doctor(options: {
    plan?: string
    planStatus?: number
    listed?: SandboxSummary[] | Error
    seed?: (userHome: string) => void
    env?: Record<string, string>
  }) {
    const api = await startFakeVercelApi()
    api.on('GET', `/v2/teams/${CREDENTIAL_ENV.VERCEL_TEAM_ID}`, () => ({
      status: options.planStatus ?? 200,
      body: { billing: { plan: options.plan ?? 'pro' } },
    }))
    const sandboxes = provider(options.listed ?? [])
    const result = await runCli(['doctor'], {
      env: { ...CREDENTIAL_ENV, ...options.env },
      sandboxes,
      network: { apiUrl: api.url, bridgePort: 1 },
      beforeRun(userHome) {
        seedInstall(userHome)
        options.seed?.(userHome)
      },
    })
    await api.close()
    return { result, api, sandboxes }
  }

  it('passes on a healthy machine and changes nothing', async () => {
    const { result, api } = await doctor({
      listed: [{ name: 'orca-aaa111', status: 'running' }],
      seed: (h) => seedWorkspace(h, 'orca-aaa111', 'app (main)'),
    })
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('ok: nothing to fix')
    expect(api.requests.every((request) => request.method === 'GET')).toBe(true)
  })

  it('reports missing prerequisites and credentials', async () => {
    const { result, sandboxes } = await doctor({
      env: { PATH: '', VERCEL_TOKEN: '', VERCEL_TEAM_ID: '', VERCEL_PROJECT_ID: '' },
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('problem: Git')
    expect(result.stderr).toContain('VERCEL_TOKEN is not set')
    expect(sandboxes.calls).toEqual([])
  })

  it('reports an adapter that is not installed and a missing Include line', async () => {
    const result = await runCli(['doctor'], { env: CREDENTIAL_ENV, sandboxes: provider([]) })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('the adapter is not installed')
    expect(result.stderr).toContain('does not hold "Include')
    expect(existsSync(join(result.userHome, '.ssh'))).toBe(false)
  })

  it('reports a missing or loose SSH key', async () => {
    const { result } = await doctor({
      seed(userHome) {
        seedWorkspace(userHome, 'orca-aaa111', 'a', 0o644)
        seedWorkspace(userHome, 'orca-bbb222', 'b')
        rmSync(join(userHome, '.vercel-orca', 'keys', 'orca-bbb222'))
      },
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('the key of orca-aaa111 is not 600')
    expect(result.stderr).toContain('orca-bbb222 has an SSH block but its key is missing')
  })

  it('warns on the Hobby plan', async () => {
    const { result } = await doctor({ plan: 'hobby' })
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('warning: the team is on the Hobby plan')
  })

  it('warns when the plan cannot be read', async () => {
    const { result } = await doctor({ planStatus: 403 })
    expect(result.stderr).toContain('warning: could not read the Vercel plan (HTTP 403)')
  })

  it('lists orphan sandboxes, such as one a killed create left behind', async () => {
    const { result } = await doctor({
      listed: [{ name: 'orca-dead00', status: 'running' }],
    })
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('warning: orphan sandbox orca-dead00 (running)')
  })

  it('reports a failed listing as a problem', async () => {
    const { result } = await doctor({ listed: new Error('cannot list sandboxes on Vercel: boom') })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('problem: cannot list sandboxes on Vercel: boom')
  })
})
