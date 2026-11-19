import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type FakeSandboxes, fakeSandboxes } from './support/fake-sandbox.ts'
import { cleanupGitDirs, git, type LocalRepo, makeRepo, tempDir } from './support/git-repo.ts'
import { cleanupHomes, runCli } from './support/run-cli.ts'

afterEach(() => {
  cleanupHomes()
  cleanupGitDirs()
})

const NAME = 'orca-abc123'

function commitIn(repo: string, file: string): void {
  writeFileSync(join(repo, file), `${file}\n`)
  git(repo, 'add', file)
  git(repo, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '--quiet', '-m', file)
}

describe('vercel-orca pull', () => {
  let local: LocalRepo
  let sandboxHome: string
  let checkout: string
  let sandboxes: FakeSandboxes
  let userHome: string

  // The sandbox's checkout is a clone of the local repo with a `feature` branch ahead of it.
  beforeEach(async () => {
    local = makeRepo()
    sandboxHome = tempDir('vercel-orca-sandbox-')
    checkout = join(sandboxHome, 'work', local.name)
    mkdirSync(join(sandboxHome, 'work'))
    git(sandboxHome, 'clone', '--quiet', local.path, checkout)
    git(checkout, 'checkout', '--quiet', '-b', 'feature')
    commitIn(checkout, 'three.txt')
    sandboxes = fakeSandboxes(
      { user: 'ubuntu', authorizeKey: () => {} },
      { home: sandboxHome, localGit: true },
    )
    await sandboxes.create({ name: NAME, ports: [], settings: {} })
    userHome = mkdtempSync(join(tempDir('vercel-orca-user-'), 'home-'))
  })

  function seedSandboxes(...names: string[]): (home: string) => void {
    return (home) => {
      const keys = join(home, '.vercel-orca', 'keys')
      mkdirSync(keys, { recursive: true })
      for (const name of names) {
        writeFileSync(join(keys, name), 'key')
        writeFileSync(join(keys, `${name}.pub`), 'key')
      }
    }
  }

  function pull(args: string[], options: { names?: string[]; cwd?: string } = {}) {
    return runCli(['pull', ...args], {
      sandboxes,
      userHome,
      cwd: options.cwd ?? local.path,
      beforeRun: seedSandboxes(...(options.names ?? [NAME])),
    })
  }

  const sandboxHead = (): string => git(checkout, 'rev-parse', 'HEAD')

  it('copies the sandbox branch and its commits under the same name by default', async () => {
    const run = await pull([NAME])
    expect(run.code).toBe(0)
    expect(git(local.path, 'rev-parse', 'refs/heads/feature')).toBe(sandboxHead())
    expect(git(local.path, 'log', '--format=%s', 'feature')).toBe('three.txt\ntwo.txt\none.txt')
    expect(run.stderr).toContain('local branch feature')
    expect(run.stderr).toContain('git push -u origin feature')
  })

  it('leaves the local checkout and the sandbox bundle file alone', async () => {
    await pull([NAME])
    expect(git(local.path, 'branch', '--show-current')).toBe('main')
    expect(sandboxes.commands.at(-1)).toContain('rm -f')
    expect(sandboxes.read).toEqual([join(sandboxHome, 'pull.bundle')])
  })

  it('defaults the sandbox to the only one known', async () => {
    const run = await pull([])
    expect(run.code).toBe(0)
    expect(sandboxes.looked.at(-1)).toEqual({ name: NAME, resume: true })
  })

  it('asks for a name when several sandboxes exist, and fails when there is none', async () => {
    const several = await pull([], { names: [NAME, 'orca-zzz999'] })
    expect(several.code).toBe(1)
    expect(several.stderr).toContain(`name the sandbox to pull from: ${NAME}, orca-zzz999`)
    userHome = mkdtempSync(join(tempDir('vercel-orca-user-'), 'home-'))
    const none = await pull([], { names: [] })
    expect(none.code).toBe(1)
    expect(none.stderr).toContain('no sandbox to pull from')
  })

  it('copies under another name with --as', async () => {
    const run = await pull([NAME, '--as', 'agent/work'])
    expect(run.code).toBe(0)
    expect(git(local.path, 'rev-parse', 'refs/heads/agent/work')).toBe(sandboxHead())
    expect(git(local.path, 'branch', '--list', 'feature')).toBe('')
  })

  it('accepts the options before the name', async () => {
    const run = await pull(['--as=other', NAME])
    expect(run.code).toBe(0)
    expect(git(local.path, 'rev-parse', 'refs/heads/other')).toBe(sandboxHead())
  })

  it('refuses to overwrite an existing local branch without --as', async () => {
    git(local.path, 'branch', 'feature', local.first)
    const run = await pull([NAME])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('local branch feature already exists')
    expect(git(local.path, 'rev-parse', 'feature')).toBe(local.first)
    expect(sandboxes.read).toEqual([])
  })

  it('replaces the branch named with --as', async () => {
    git(local.path, 'branch', 'keep', local.first)
    const run = await pull([NAME, '--as', 'keep'])
    expect(run.code).toBe(0)
    expect(git(local.path, 'rev-parse', 'keep')).toBe(sandboxHead())
  })

  it('needs --as for a detached checkout, then copies HEAD under that name', async () => {
    git(checkout, 'checkout', '--quiet', '--detach')
    const refused = await pull([NAME])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('detached: name the local branch with --as')
    const run = await pull([NAME, '--as', 'detached'])
    expect(run.code).toBe(0)
    expect(git(local.path, 'rev-parse', 'detached')).toBe(sandboxHead())
  })

  it('refuses an invalid or option-like branch name', async () => {
    for (const bad of ['-x', 'a..b', 'with space']) {
      const run = await pull([NAME, `--as=${bad}`])
      expect(run.code).toBe(1)
      expect(run.stderr).toContain(`unsupported branch name: ${bad}`)
    }
  })

  it('refuses while the workspace is asleep, without calling Vercel', async () => {
    mkdirSync(join(userHome, '.vercel-orca', 'state'), { recursive: true })
    writeFileSync(join(userHome, '.vercel-orca', 'state', `${NAME}.asleep`), '')
    const run = await pull([NAME])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain(`sandbox ${NAME} is asleep`)
    expect(sandboxes.looked).toEqual([])
  })

  it('fails clearly outside a Git repository', async () => {
    const run = await pull([NAME], { cwd: tempDir('vercel-orca-plain-') })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('git rev-parse failed')
  })

  it('fails clearly when the sandbox has no checkout of this repository', async () => {
    const other = makeRepo('elsewhere')
    const run = await pull([NAME], { cwd: other.path })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain(`sandbox ${NAME} has no checkout at`)
  })

  it('rejects extra arguments and unknown flags with the usage', async () => {
    for (const args of [
      [NAME, 'extra'],
      [NAME, '--force'],
    ]) {
      const run = await pull(args)
      expect(run.code).toBe(1)
    }
    expect((await pull([NAME, '--force'])).stderr).toContain('usage: vercel-orca pull')
  })

  it('rejects an invalid sandbox name', async () => {
    const run = await pull(['../etc'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('invalid sandbox name')
  })
})
