import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CommandContext } from '../src/commands.ts'
import { resumeCommand, suspendCommand } from '../src/lifecycle.ts'
import { CREDENTIAL_ENV, sandboxBody } from './support/fake-network.ts'
import { type FakeSandboxes, fakeSandboxes } from './support/fake-sandbox.ts'
import { type FakeVercelApi, startFakeVercelApi } from './support/fake-vercel-api.ts'
import { type LocalSshd, sshdAvailable, startLocalSshd } from './support/local-sshd.ts'
import { cleanupHomes, runCli } from './support/run-cli.ts'
import { startWsBridge, type WsBridge } from './support/ws-bridge.ts'

const PROXY_PROCESS = join(dirname(fileURLToPath(import.meta.url)), 'support', 'proxy-process.ts')

afterEach(cleanupHomes)

describe.skipIf(!sshdAvailable())('vercel-orca suspend and resume', () => {
  let sshd: LocalSshd
  let bridge: WsBridge
  let api: FakeVercelApi
  let sandboxes: FakeSandboxes
  let userHome: string
  let name: string
  let payload: string

  function installShim(home: string): void {
    const bin = join(home, '.vercel-orca', 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'vercel-orca'), `#!/bin/sh\nexec node "${PROXY_PROCESS}" "$2"\n`)
    chmodSync(join(bin, 'vercel-orca'), 0o755)
  }

  function cli(argv: string[], stdin?: string) {
    return runCli(argv, {
      env: { ...CREDENTIAL_ENV, FAKE_API_URL: api.url, FAKE_BRIDGE_PORT: String(bridge.port) },
      sandboxes,
      network: { apiUrl: api.url, bridgePort: bridge.port },
      userHome,
      stdin,
      beforeRun: installShim,
    })
  }

  beforeEach(async () => {
    sshd = await startLocalSshd()
    bridge = await startWsBridge(sshd.port)
    api = await startFakeVercelApi()
    sandboxes = fakeSandboxes(sshd, {
      onCreate: (created) =>
        api.on('GET', `/v2/sandboxes/${created}`, () => ({ body: sandboxBody(created) })),
    })
    const created = await cli(['create'])
    userHome = created.userHome
    name = JSON.parse(created.stdout).userData.resourceId
    payload = JSON.stringify({ recipeResult: { userData: { resourceId: name } } })
  })
  afterEach(async () => {
    await api.close()
    await bridge.close()
    await sshd.stop()
  })

  const sshConfig = (home: string): string => readFileSync(join(home, 'ssh_config'), 'utf8')

  it('stops the sandbox on suspend and marks the workspace asleep', async () => {
    const run = await cli(['suspend'], payload)
    expect(run.code).toBe(0)
    expect(sandboxes.stopped).toEqual([name])
    expect(existsSync(join(run.home, 'state', `${name}.asleep`))).toBe(true)
  })

  it('makes proxy refuse with a clear message while asleep, without calling Vercel', async () => {
    await cli(['suspend'], payload)
    const before = api.requests.length
    const run = await cli(['proxy', name])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain(`sandbox ${name} is asleep`)
    expect(api.requests).toHaveLength(before)
  })

  it('keeps the workspace awake when the stop fails', async () => {
    const failing = fakeSandboxes(sshd, { failStop: true })
    await failing.create({ name, ports: [] })
    const run = await runCli(['suspend'], { stdin: payload, userHome, sandboxes: failing })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('stop failed')
    expect(existsSync(join(run.home, 'state', `${name}.asleep`))).toBe(false)
  })

  it('keeps an earlier asleep mark when a repeated suspend fails', async () => {
    await cli(['suspend'], payload)
    const failing = fakeSandboxes(sshd, { failStop: true })
    await failing.create({ name, ports: [] })
    const run = await runCli(['suspend'], { stdin: payload, userHome, sandboxes: failing })
    expect(run.code).toBe(1)
    expect(existsSync(join(run.home, 'state', `${name}.asleep`))).toBe(true)
  })

  it('resumes, restarts sshd and the bridge, and clears the asleep mark', async () => {
    await cli(['suspend'], payload)
    const commandsBefore = sandboxes.commands.length
    const run = await cli(['resume'], payload)
    expect(run.code).toBe(0)
    expect(sandboxes.looked.at(-1)).toEqual({ name, resume: true })
    const started = sandboxes.commands.slice(commandsBefore).join('\n')
    expect(started).toContain('/usr/sbin/sshd')
    expect(started).toContain('ws-l:0.0.0.0:8080')
    expect(started).not.toContain('apt-get')
    expect(existsSync(join(run.home, 'state', `${name}.asleep`))).toBe(false)
  })

  it('starts sshd and the bridge only when they are not running, so a second resume is harmless', async () => {
    await cli(['resume'], payload)
    const guards = sandboxes.commands.filter((command) => command.includes('sshd -f'))
    expect(guards.at(-1)).toContain('pgrep -x sshd >/dev/null ||')
    const bridgeStart = sandboxes.commands.filter((command) => command.includes('ws-l:'))
    expect(bridgeStart.at(-1)).toContain('pgrep -x websocat >/dev/null ||')
  })

  it('leaves the SSH target byte-identical and SSH working after resume', async () => {
    const before = sshConfig(join(userHome, '.vercel-orca'))
    await cli(['suspend'], payload)
    await cli(['resume'], payload)
    expect(sshConfig(join(userHome, '.vercel-orca'))).toBe(before)
  })

  it('fails resume for a sandbox Vercel does not know', async () => {
    const run = await cli(
      ['resume'],
      JSON.stringify({ recipeResult: { userData: { resourceId: 'orca-nope' } } }),
    )
    expect(run.code).toBe(1)
    expect(run.readLog()).toContain('resume sandbox=orca-nope failed')
  })
})

describe('suspend and resume without a payload', () => {
  it.each([suspendCommand, resumeCommand])('refuse to run, with a clear error', async (command) => {
    await expect(command.run({ env: {} } as CommandContext)).rejects.toThrow(
      'needs the lifecycle payload',
    )
  })
})
