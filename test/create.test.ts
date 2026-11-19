import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CREDENTIAL_ENV, sandboxBody } from './support/fake-network.ts'
import {
  type FakeSandboxes,
  type FakeSandboxOptions,
  fakeSandboxes,
} from './support/fake-sandbox.ts'
import { type FakeVercelApi, startFakeVercelApi } from './support/fake-vercel-api.ts'
import { type LocalSshd, sshdAvailable, startLocalSshd } from './support/local-sshd.ts'
import { cleanupHomes, runCli } from './support/run-cli.ts'
import { startWsBridge, type WsBridge } from './support/ws-bridge.ts'

const PROXY_PROCESS = join(dirname(fileURLToPath(import.meta.url)), 'support', 'proxy-process.ts')

afterEach(cleanupHomes)

describe.skipIf(!sshdAvailable())('vercel-orca create', () => {
  let sshd: LocalSshd
  let bridge: WsBridge
  let api: FakeVercelApi
  let sandboxes: FakeSandboxes

  beforeEach(async () => {
    sshd = await startLocalSshd()
    bridge = await startWsBridge(sshd.port)
    api = await startFakeVercelApi()
  })
  afterEach(async () => {
    await api.close()
    await bridge.close()
    await sshd.stop()
  })

  // The installed adapter's launcher, pointed at the fake API: ssh runs it as the ProxyCommand.
  function installShim(userHome: string): void {
    const bin = join(userHome, '.vercel-orca', 'bin')
    const shim = join(bin, 'vercel-orca')
    mkdirSync(bin, { recursive: true })
    writeFileSync(shim, `#!/bin/sh\nexec node "${PROXY_PROCESS}" "$2"\n`)
    chmodSync(shim, 0o755)
  }

  // Runs `create` against a fake sandbox; the fake Vercel API learns each name the proxy looks up.
  async function create(options: FakeSandboxOptions = {}, userHome?: string) {
    sandboxes = fakeSandboxes(sshd, {
      ...options,
      onCreate: (name) =>
        api.on('GET', `/v2/sandboxes/${name}`, () => ({ body: sandboxBody(name) })),
    })
    const run = await runCli(['create'], {
      env: { ...CREDENTIAL_ENV, FAKE_API_URL: api.url, FAKE_BRIDGE_PORT: String(bridge.port) },
      sandboxes,
      network: { apiUrl: api.url, bridgePort: bridge.port },
      userHome,
      beforeRun: installShim,
    })
    return { run, name: sandboxes.created[0]?.name as string }
  }

  it('prints only the JSON result, with the SSH target, project root and resource id', async () => {
    const { run, name: sandbox } = await create()
    expect(run.code).toBe(0)
    const result = JSON.parse(run.stdout)
    expect(run.stdout.trim().split('\n')).toHaveLength(1)
    expect(result).toEqual({
      sshTarget: {
        host: sandbox,
        port: 22,
        username: sshd.user,
        proxyCommand: `'${join(run.home, 'bin', 'vercel-orca')}' proxy ${sandbox}`,
      },
      projectRoot: '/vercel/work',
      userData: { resourceId: sandbox },
    })
  })

  it('creates a persistent sandbox with the bridge port published', async () => {
    await create()
    expect(sandboxes.created).toHaveLength(1)
    expect(sandboxes.created[0]?.ports).toEqual([8080])
    expect(sandboxes.created[0]?.name).toMatch(/^orca-[0-9a-f]{6}$/)
  })

  it('keeps the private key local (600) and sends only the public key to the sandbox', async () => {
    const { run, name } = await create()
    const keyPath = join(run.home, 'keys', name)
    expect(statSync(keyPath).mode & 0o777).toBe(0o600)
    const privateKey = readFileSync(keyPath, 'utf8')
    const publicKey = readFileSync(`${keyPath}.pub`, 'utf8').trim()
    const sent = [...sandboxes.commands, ...sandboxes.files.map((file) => file.content)].join('\n')
    expect(sent).not.toContain('PRIVATE KEY')
    expect(sent).not.toContain(privateKey.split('\n')[1] as string)
    expect(sent).not.toContain(CREDENTIAL_ENV.VERCEL_TOKEN)
    const authorized = sandboxes.files.find((file) => file.path.endsWith('authorized_keys'))
    expect(authorized?.content.trim()).toBe(publicKey)
    expect(authorized?.mode).toBe(0o600)
  })

  it('installs sshd on 127.0.0.1 with password login off, and starts the bridge', async () => {
    await create()
    const config = sandboxes.files.find((file) => file.path.endsWith('sshd_config'))?.content
    expect(config).toContain('ListenAddress 127.0.0.1')
    expect(config).toContain('PasswordAuthentication no')
    const commands = sandboxes.commands.join('\n')
    expect(commands).toContain('openssh-server')
    expect(commands).toContain('websocat')
    expect(commands).toContain('ws-l:0.0.0.0:8080')
  })

  it('adds a host block to the adapter ssh_config', async () => {
    const { run, name } = await create()
    const config = readFileSync(join(run.home, 'ssh_config'), 'utf8')
    expect(config).toContain(`Host ${name}`)
    expect(config).toContain(`IdentityFile ${join(run.home, 'keys', name)}`)
    expect(config).toContain(`proxy ${name}`)
  })

  it('logs the sandbox name and timings, never the key', async () => {
    const { run, name } = await create()
    expect(run.readLog()).toContain(`create ${name}`)
    expect(run.readLog()).not.toContain('PRIVATE KEY')
  })

  it('deletes the sandbox and its local traces when the install fails', async () => {
    const { run, name } = await create({ failOn: 'openssh-server' })
    expect(run.code).toBe(1)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('openssh-server')
    expect(sandboxes.deleted).toEqual([name])
    expect(existsSync(join(run.home, 'keys', name))).toBe(false)
    expect(existsSync(join(run.home, 'ssh_config'))).toBe(false)
  })

  it('does not print a result when the SSH connection cannot be verified', async () => {
    const { run } = await create({ withholdKey: true })
    expect(run.code).toBe(1)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('SSH connection')
    expect(sandboxes.deleted).toHaveLength(1)
  })

  it('pins the websocat download by checksum and architecture', async () => {
    await create()
    const install = sandboxes.commands.find((command) => command.includes('curl')) as string
    expect(install).toContain('sha256sum -c')
    expect(install).toContain('x86_64')
    expect(install.indexOf('sha256sum -c')).toBeLessThan(install.indexOf('chmod 755'))
  })

  it('sends the bridge output to a log it reads back when the SSH check fails', async () => {
    const { run } = await create({ withholdKey: true, bridgeLog: 'websocat: address in use' })
    expect(sandboxes.commands.join('\n')).toContain('websocat.log')
    expect(run.stderr).toContain('websocat: address in use')
  })

  it.each([
    ['a home with a space', { home: '/home/a b' }],
    ['a home with a shell metacharacter', { home: '/home/x;rm -rf /' }],
    ['a user with a space', { user: 'a b' }],
  ])('refuses %s in the sandbox identity', async (_label, identity) => {
    const { run, name } = await create(identity)
    expect(run.code).toBe(1)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('unexpected user or home')
    expect(sandboxes.deleted).toEqual([name])
  })

  it('still removes the private key when the ssh_config cleanup fails', async () => {
    const userHome = mkdtempSync(join(tmpdir(), 'vercel-orca-create-'))
    const sshConfig = join(userHome, '.vercel-orca', 'ssh_config')
    const { run, name } = await create(
      {
        failOn: 'openssh-server',
        // A directory where the file was makes the host block's removal throw.
        onDelete: () => {
          rmSync(sshConfig, { force: true })
          mkdirSync(sshConfig)
        },
      },
      userHome,
    )
    expect(run.code).toBe(1)
    expect(existsSync(join(run.home, 'keys', name))).toBe(false)
    rmSync(userHome, { recursive: true, force: true })
  })
})
