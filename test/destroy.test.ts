import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CREDENTIAL_ENV, sandboxBody } from './support/fake-network.ts'
import { type FakeSandboxes, fakeSandboxes } from './support/fake-sandbox.ts'
import { type FakeVercelApi, startFakeVercelApi } from './support/fake-vercel-api.ts'
import { cleanupGitDirs, git, type LocalRepo, makeRepo, tempDir } from './support/git-repo.ts'
import { type LocalSshd, sshdAvailable, startLocalSshd } from './support/local-sshd.ts'
import { cleanupHomes, runCli } from './support/run-cli.ts'
import { startWsBridge, type WsBridge } from './support/ws-bridge.ts'

const HOST_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqetCUJ5mKJ1bpmqAkWgl+rWzGBtpBN2ZPUB5rJJt'
const PROXY_PROCESS = join(dirname(fileURLToPath(import.meta.url)), 'support', 'proxy-process.ts')

afterEach(() => {
  cleanupHomes()
  cleanupGitDirs()
})

describe.skipIf(!sshdAvailable())('vercel-orca destroy', () => {
  let sshd: LocalSshd
  let bridge: WsBridge
  let api: FakeVercelApi
  let sandboxes: FakeSandboxes
  let sandboxHome: string
  let repo: LocalRepo
  let userHome: string
  let name: string
  let payload: string
  let work: string

  function destroy() {
    return runCli(['destroy'], { stdin: payload, userHome, sandboxes })
  }

  // Commits in the sandbox's checkout, as the agent would.
  function sandboxGit(...args: string[]): string {
    return git(work, '-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', ...args)
  }

  const saved = (): string[] =>
    git(
      repo.path,
      'for-each-ref',
      '--format=%(refname:strip=5)',
      `refs/heads/vercel-orca/saved/${name}`,
    )
      .split('\n')
      .filter(Boolean)

  const show = (ref: string, file: string): string =>
    git(repo.path, 'show', `vercel-orca/saved/${name}/${ref}:${file}`)

  beforeEach(async () => {
    sshd = await startLocalSshd()
    bridge = await startWsBridge(sshd.port)
    api = await startFakeVercelApi()
    sandboxHome = tempDir('vercel-orca-sandbox-')
    sandboxes = fakeSandboxes(sshd, {
      home: sandboxHome,
      localGit: true,
      onCreate: (created) =>
        api.on('GET', `/v2/sandboxes/${created}`, () => ({ body: sandboxBody(created) })),
    })
    repo = makeRepo()
    const created = await runCli(['create'], {
      env: {
        ...CREDENTIAL_ENV,
        ORCA_REPO_PATH: repo.path,
        ORCA_REPO_BRANCH: 'main',
        ORCA_REPO_REF_HEAD: repo.head,
        FAKE_API_URL: api.url,
        FAKE_BRIDGE_PORT: String(bridge.port),
      },
      sandboxes,
      network: { apiUrl: api.url, bridgePort: bridge.port },
      beforeRun(home) {
        const bin = join(home, '.vercel-orca', 'bin')
        mkdirSync(bin, { recursive: true })
        writeFileSync(join(bin, 'vercel-orca'), `#!/bin/sh\nexec node "${PROXY_PROCESS}" "$2"\n`, {
          mode: 0o755,
        })
      },
    })
    userHome = created.userHome
    name = JSON.parse(created.stdout).userData.resourceId
    payload = JSON.stringify({ recipeResult: { userData: { resourceId: name } } })
    work = join(sandboxHome, 'work', repo.name)
  })
  afterEach(async () => {
    await api.close()
    await bridge.close()
    await sshd.stop()
  })

  it('deletes the sandbox and leaves no key, SSH block or state behind', async () => {
    const run = await destroy()
    expect(run.code).toBe(0)
    expect(sandboxes.deleted).toEqual([name])
    expect(existsSync(join(run.home, 'keys', name))).toBe(false)
    expect(existsSync(join(run.home, 'keys', `${name}.pub`))).toBe(false)
    expect(readFileSync(join(run.home, 'ssh_config'), 'utf8')).not.toContain(name)
    expect(existsSync(join(run.home, 'state', `${name}.json`))).toBe(false)
    expect(saved()).toEqual([])
  })

  it('drops the sandbox from known_hosts', async () => {
    const knownHosts = join(userHome, '.ssh', 'known_hosts')
    mkdirSync(join(userHome, '.ssh'), { recursive: true })
    writeFileSync(knownHosts, `${name} ssh-ed25519 ${HOST_KEY}\n`)
    await destroy()
    expect(readFileSync(knownHosts, 'utf8')).not.toContain(name)
  })

  it('wakes the sandbox first and drops the asleep mark', async () => {
    await runCli(['suspend'], { stdin: payload, userHome, sandboxes })
    const run = await destroy()
    expect(sandboxes.looked.at(-1)).toEqual({ name, resume: true })
    expect(existsSync(join(run.home, 'state', `${name}.asleep`))).toBe(false)
  })

  it('saves a branch with new commits', async () => {
    sandboxGit('checkout', '-q', '-b', 'feature')
    writeFileSync(join(work, 'agent.txt'), 'agent work\n')
    sandboxGit('add', 'agent.txt')
    sandboxGit('commit', '-q', '-m', 'agent')
    sandboxGit('checkout', '-q', 'main')
    await destroy()
    expect(saved()).toEqual(['branches/feature'])
    expect(show('branches/feature', 'agent.txt')).toBe('agent work')
  })

  it('saves uncommitted changes, untracked files included', async () => {
    writeFileSync(join(work, 'one.txt'), 'edited\n')
    writeFileSync(join(work, 'new.txt'), 'untracked\n')
    await destroy()
    expect(saved()).toEqual(['uncommitted'])
    expect(show('uncommitted', 'one.txt')).toBe('edited')
    expect(show('uncommitted', 'new.txt')).toBe('untracked')
    expect(git(repo.path, 'rev-parse', `refs/heads/vercel-orca/saved/${name}/uncommitted^`)).toBe(
      repo.head,
    )
  })

  it('saves the latest stash', async () => {
    writeFileSync(join(work, 'one.txt'), 'stashed\n')
    sandboxGit('stash', 'push', '-q')
    await destroy()
    expect(saved()).toEqual(['stash'])
    expect(show('stash', 'one.txt')).toBe('stashed')
  })

  it('saves commits made on a detached HEAD', async () => {
    sandboxGit('checkout', '-q', '--detach')
    writeFileSync(join(work, 'loose.txt'), 'loose\n')
    sandboxGit('add', 'loose.txt')
    sandboxGit('commit', '-q', '-m', 'loose')
    await destroy()
    expect(saved()).toEqual(['detached'])
    expect(show('detached', 'loose.txt')).toBe('loose')
  })

  it('saves another worktree: its detached commits and uncommitted changes', async () => {
    const other = join(sandboxHome, 'other')
    sandboxGit('worktree', 'add', '-q', '--detach', other)
    git(
      other,
      '-c',
      'user.name=A',
      '-c',
      'user.email=a@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'wt',
    )
    writeFileSync(join(other, 'wt.txt'), 'in worktree\n')
    await destroy()
    expect(saved()).toEqual(['worktrees/other/detached', 'worktrees/other/uncommitted'])
    expect(show('worktrees/other/uncommitted', 'wt.txt')).toBe('in worktree')
  })

  it('keeps the sandbox, the key and the SSH block when saving fails, and says why', async () => {
    writeFileSync(join(work, 'new.txt'), 'untracked\n')
    sandboxes.failOn = 'bundle create'
    const run = await destroy()
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('bundle create')
    expect(sandboxes.deleted).toEqual([])
    expect(existsSync(join(run.home, 'keys', name))).toBe(true)
    expect(readFileSync(join(run.home, 'ssh_config'), 'utf8')).toContain(name)
    expect(saved()).toEqual([])
  })
})
