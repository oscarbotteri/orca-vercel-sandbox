import { afterEach, describe, expect, it } from 'vitest'
import { httpsOrigin, prepareCheckout } from '../src/git-bundle.ts'
import { cleanupGitDirs, makeRepo } from './support/git-repo.ts'

afterEach(cleanupGitDirs)

describe('httpsOrigin', () => {
  it.each([
    ['https://github.com/acme/project.git', 'https://github.com/acme/project.git'],
    ['https://user:token@github.com/acme/project.git', 'https://github.com/acme/project.git'],
    ['http://github.com/acme/project.git', 'https://github.com/acme/project.git'],
    ['git@github.com:acme/project.git', 'https://github.com/acme/project.git'],
    ['ssh://git@github.com:2222/acme/project.git', 'https://github.com/acme/project.git'],
    [
      'https://git.example.com:8443/acme/project.git',
      'https://git.example.com:8443/acme/project.git',
    ],
  ])('turns %s into %s', (remote, expected) => {
    expect(httpsOrigin(remote)).toBe(expected)
  })

  it.each(['file:///srv/repo.git', 'not a url'])('has no HTTPS form for %s', (remote) => {
    expect(httpsOrigin(remote)).toBeUndefined()
  })
})

describe('prepareCheckout', () => {
  it('refuses a commit that is not a full object id', async () => {
    const repo = makeRepo()
    await expect(
      prepareCheckout({ ORCA_REPO_PATH: repo.path, ORCA_REPO_REF_HEAD: 'main' }),
    ).rejects.toThrow('invalid commit')
  })

  it('refuses a branch name with shell metacharacters', async () => {
    const repo = makeRepo()
    await expect(
      prepareCheckout({ ORCA_REPO_PATH: repo.path, ORCA_REPO_BRANCH: 'a;rm -rf /' }),
    ).rejects.toThrow('unsupported branch')
  })

  it.each(['feature#12', 'fix+1', 'release@2'])('accepts the valid branch %s', async (branch) => {
    const repo = makeRepo()
    const source = await prepareCheckout({ ORCA_REPO_PATH: repo.path, ORCA_REPO_BRANCH: branch })
    expect(source.branch).toBe(branch)
  })

  it.each(['a..b', 'foo.lock', 'x/', '-x'])('refuses the invalid branch %s', async (branch) => {
    const repo = makeRepo()
    await expect(
      prepareCheckout({ ORCA_REPO_PATH: repo.path, ORCA_REPO_BRANCH: branch }),
    ).rejects.toThrow('unsupported branch')
  })

  it('uses a different bundle ref for every run', async () => {
    const repo = makeRepo()
    const env = { ORCA_REPO_PATH: repo.path }
    const [a, b] = await Promise.all([prepareCheckout(env), prepareCheckout(env)])
    expect(a.bundleRef).not.toBe(b.bundleRef)
  })

  it('checks the git identity before building the bundle', async () => {
    const repo = makeRepo('project', false)
    await expect(
      prepareCheckout({
        ORCA_REPO_PATH: repo.path,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      }),
    ).rejects.toThrow('user.name')
  })

  it('reports the git error when the ref does not resolve', async () => {
    const repo = makeRepo()
    await expect(
      prepareCheckout({ ORCA_REPO_PATH: repo.path, ORCA_REPO_REF: 'nope' }),
    ).rejects.toThrow('git rev-parse failed')
  })
})
