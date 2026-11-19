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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessControl } from '../src/main.ts'
import { CREDENTIAL_ENV, sandboxBody } from './support/fake-network.ts'
import { type FakeProcess, fakeProcess } from './support/fake-process.ts'
import {
  type FakeSandboxes,
  type FakeSandboxOptions,
  fakeSandboxes,
} from './support/fake-sandbox.ts'
import { type FakeVercelApi, startFakeVercelApi } from './support/fake-vercel-api.ts'
import { cleanupGitDirs, git, type LocalRepo, makeRepo, tempDir } from './support/git-repo.ts'
import { type LocalSshd, sshdAvailable, startLocalSshd } from './support/local-sshd.ts'
import { cleanupHomes, runCli } from './support/run-cli.ts'
import { startWsBridge, type WsBridge } from './support/ws-bridge.ts'

const HOST_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqetCUJ5mKJ1bpmqAkWgl+rWzGBtpBN2ZPUB5rJJt'
const PROXY_PROCESS = join(dirname(fileURLToPath(import.meta.url)), 'support', 'proxy-process.ts')

afterEach(cleanupHomes)
afterEach(cleanupGitDirs)

describe.skipIf(!sshdAvailable())('vercel-orca create', () => {
  let sshd: LocalSshd
  let bridge: WsBridge
  let api: FakeVercelApi
  let sandboxes: FakeSandboxes
  let sandboxHome: string
  let repo: LocalRepo | undefined

  beforeEach(async () => {
    repo = undefined
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
  // The checkout runs for real in a temporary directory that stands in for the sandbox's home.
  async function create(
    options: FakeSandboxOptions = {},
    userHome?: string,
    orcaEnv?: Record<string, string>,
    proc?: ProcessControl,
  ) {
    sandboxHome = tempDir('vercel-orca-sandbox-')
    repo ??= makeRepo()
    sandboxes = fakeSandboxes(sshd, {
      home: sandboxHome,
      localGit: true,
      ...options,
      onCreate: (name) =>
        api.on('GET', `/v2/sandboxes/${name}`, () => ({ body: sandboxBody(name) })),
    })
    const run = await runCli(['create'], {
      env: {
        ...CREDENTIAL_ENV,
        ORCA_REPO_PATH: repo.path,
        ORCA_REPO_BRANCH: 'main',
        ORCA_REPO_REF_HEAD: repo.head,
        ...orcaEnv,
        FAKE_API_URL: api.url,
        FAKE_BRIDGE_PORT: String(bridge.port),
      },
      sandboxes,
      network: { apiUrl: api.url, bridgePort: bridge.port },
      userHome,
      process: proc,
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
      projectRoot: `${sandboxHome}/work/project`,
      userData: { resourceId: sandbox },
    })
  })

  describe('git checkout', () => {
    function inSandbox(dir = 'project'): string {
      return join(sandboxHome, 'work', dir)
    }

    it('puts a new branch on the commit Orca picked', async () => {
      repo = makeRepo()
      const { run } = await create({}, undefined, {
        ORCA_REPO_BRANCH: 'feature/new',
        ORCA_REPO_REF_HEAD: repo.first,
      })
      expect(run.code).toBe(0)
      expect(git(inSandbox(), 'symbolic-ref', 'HEAD')).toBe('refs/heads/feature/new')
      expect(git(inSandbox(), 'rev-parse', 'HEAD')).toBe(repo.first)
      expect(JSON.parse(run.stdout).projectRoot).toBe(inSandbox())
    })

    it('checks out an existing branch with its history', async () => {
      repo = makeRepo()
      git(repo.path, 'branch', 'work', repo.head)
      const { run } = await create({}, undefined, { ORCA_REPO_BRANCH: 'refs/heads/work' })
      expect(run.code).toBe(0)
      expect(git(inSandbox(), 'symbolic-ref', 'HEAD')).toBe('refs/heads/work')
      expect(git(inSandbox(), 'rev-parse', 'HEAD')).toBe(repo.head)
      expect(git(inSandbox(), 'rev-list', '--count', 'HEAD')).toBe('2')
      expect(git(inSandbox(), 'status', '--porcelain')).toBe('')
    })

    it('detaches at the commit when Orca picked no branch', async () => {
      repo = makeRepo()
      const { run } = await create({}, undefined, {
        ORCA_REPO_BRANCH: '',
        ORCA_REPO_REF_HEAD: repo.first,
      })
      expect(run.code).toBe(0)
      expect(() => git(inSandbox(), 'symbolic-ref', '--quiet', 'HEAD')).toThrow()
      expect(git(inSandbox(), 'rev-parse', 'HEAD')).toBe(repo.first)
    })

    it('resolves the ref when Orca sent no commit', async () => {
      repo = makeRepo()
      await create({}, undefined, { ORCA_REPO_REF_HEAD: '', ORCA_REPO_REF: 'main~1' })
      expect(git(inSandbox(), 'rev-parse', 'HEAD')).toBe(repo.first)
    })

    it('sets the git identity and an HTTPS origin without credentials', async () => {
      repo = makeRepo()
      await create({}, undefined, {
        ORCA_REPO_URL: 'https://user:secret-token@github.com/acme/project.git',
      })
      expect(git(inSandbox(), 'config', 'user.name')).toBe('Ada Lovelace')
      expect(git(inSandbox(), 'config', 'user.email')).toBe('ada@example.com')
      expect(git(inSandbox(), 'remote', 'get-url', 'origin')).toBe(
        'https://github.com/acme/project.git',
      )
      expect(sandboxes.commands.join('\n')).not.toContain('secret-token')
    })

    it('turns an SSH remote into its HTTPS form', async () => {
      repo = makeRepo()
      await create({}, undefined, { ORCA_REPO_URL: 'git@github.com:acme/project.git' })
      expect(git(inSandbox(), 'remote', 'get-url', 'origin')).toBe(
        'https://github.com/acme/project.git',
      )
    })

    it('adds no origin when the repository has no remote', async () => {
      repo = makeRepo()
      await create({}, undefined, { ORCA_REPO_URL: '' })
      expect(git(inSandbox(), 'remote')).toBe('')
    })

    it('sends no credential and leaves the local repository untouched', async () => {
      repo = makeRepo()
      const { run } = await create({}, undefined, { GITHUB_TOKEN: 'ghp_secret' })
      const sent = [...sandboxes.commands, ...sandboxes.files.map((file) => file.content)].join(
        '\n',
      )
      expect(sent).not.toContain('ghp_secret')
      expect(run.code).toBe(0)
      expect(git(repo.path, 'for-each-ref', 'refs/vercel-orca')).toBe('')
      expect(sandboxes.files.some((file) => file.path.endsWith('checkout.bundle'))).toBe(true)
      expect(existsSync(join(sandboxHome, 'checkout.bundle'))).toBe(false)
    })

    it('fails before creating a sandbox when the repository has no git identity', async () => {
      repo = makeRepo('project', false)
      const { run } = await create({}, undefined, {
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      })
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('user.name')
      expect(sandboxes.created).toHaveLength(0)
    })

    it('fails before creating a sandbox when Orca names no repository', async () => {
      const { run } = await create({}, undefined, { ORCA_REPO_PATH: '' })
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('which repository')
      expect(sandboxes.created).toHaveLength(0)
    })

    it('deletes the sandbox when the commit cannot be unpacked', async () => {
      const { run, name } = await create({ failOn: 'fetch --quiet' })
      expect(run.code).toBe(1)
      expect(run.stdout).toBe('')
      expect(sandboxes.deleted).toEqual([name])
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

  it.each([
    ['reading the identity', { failOn: 'id -un' }],
    ['installing the bridge', { failOn: 'openssh-server' }],
    ['starting the bridge', { failOn: 'ws-l:0.0.0.0' }],
    ['verifying the SSH connection', { withholdKey: true }],
  ])('leaves no sandbox, key or SSH block when %s fails', async (_step, options) => {
    const { run, name } = await create(options)
    expect(run.code).toBe(1)
    expect(sandboxes.deleted).toEqual([name])
    expect(existsSync(join(run.home, 'keys', name))).toBe(false)
    expect(existsSync(join(run.home, 'keys', `${name}.pub`))).toBe(false)
    const config = existsSync(join(run.home, 'ssh_config'))
      ? readFileSync(join(run.home, 'ssh_config'), 'utf8')
      : ''
    expect(config).not.toContain(name)
    expect(run.readLog()).toContain(`create ${name}: cleanup done`)
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

  describe('when cancelled', () => {
    function holdAt(step: string, proc: () => FakeProcess, signal: NodeJS.Signals) {
      return (command: string) => {
        if (!command.includes(step)) return undefined
        proc().raise(signal)
        return new Promise<void>(() => {})
      }
    }

    it.each(['SIGINT', 'SIGTERM'] as const)(
      'removes the sandbox, key and SSH block on %s and exits 130',
      async (signal) => {
        const proc = fakeProcess()
        const userHome = mkdtempSync(join(tmpdir(), 'vercel-orca-create-'))
        void create(
          { onCommand: holdAt('openssh-server', () => proc, signal) },
          userHome,
          undefined,
          proc,
        )
        await proc.exited
        const name = sandboxes.created[0]?.name as string
        const home = join(userHome, '.vercel-orca')
        expect(proc.exitCodes).toEqual([130])
        expect(sandboxes.deleted).toEqual([name])
        expect(existsSync(join(home, 'keys', name))).toBe(false)
        expect(existsSync(join(home, 'ssh_config'))).toBe(false)
        expect(readFileSync(join(home, 'lifecycle.log'), 'utf8')).toContain(
          `create ${name}: cleanup done`,
        )
        rmSync(userHome, { recursive: true, force: true })
      },
    )

    it('waits for a sandbox that is still being created, then removes it', async () => {
      const proc = fakeProcess()
      let release: () => void = () => {}
      const userHome = mkdtempSync(join(tmpdir(), 'vercel-orca-create-'))
      void create(
        {
          beforeCreateResolves: () => {
            // The handler is registered right after provider.create is called.
            setTimeout(() => proc.raise('SIGINT'), 0)
            return new Promise<void>((resolve) => {
              release = resolve
            })
          },
        },
        userHome,
        undefined,
        proc,
      )
      await vi.waitFor(() => expect(sandboxes.created).toHaveLength(1))
      expect(proc.exitCodes).toEqual([])
      release()
      await proc.exited
      expect(sandboxes.deleted).toEqual([sandboxes.created[0]?.name])
      expect(proc.exitCodes).toEqual([130])
      rmSync(userHome, { recursive: true, force: true })
    })

    it('does not listen for signals once create has finished', async () => {
      const proc = fakeProcess()
      await create({}, undefined, undefined, proc)
      proc.raise('SIGINT')
      expect(proc.exitCodes).toEqual([])
      expect(sandboxes.deleted).toEqual([])
    })
  })

  describe('known_hosts', () => {
    it('removes the entry ssh recorded when the SSH check fails after the key was trusted', async () => {
      const userHome = mkdtempSync(join(tmpdir(), 'vercel-orca-create-'))
      const knownHosts = join(userHome, '.ssh', 'known_hosts')
      let name = ''
      const { run } = await create(
        {
          failOn: 'websocat.log',
          onDelete: () => {
            name = sandboxes.created[0]?.name as string
            mkdirSync(join(userHome, '.ssh'), { recursive: true })
            writeFileSync(knownHosts, `${name} ssh-ed25519 ${HOST_KEY}\n`)
          },
        },
        userHome,
      )
      expect(run.code).toBe(1)
      expect(readFileSync(knownHosts, 'utf8')).not.toContain(name)
      rmSync(userHome, { recursive: true, force: true })
    })
  })
})
