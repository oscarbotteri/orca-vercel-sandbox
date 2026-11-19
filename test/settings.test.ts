import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sandboxCreateParams } from '../src/sandbox-session.ts'
import { installSshBridge } from '../src/sandbox-ssh.ts'
import { parseSettings, toCreateParams } from '../src/settings.ts'
import { fakeSandboxes } from './support/fake-sandbox.ts'
import type { LocalSshd } from './support/local-sshd.ts'
import { cleanupHomes, runCli } from './support/run-cli.ts'

afterEach(cleanupHomes)

const CREDENTIALS = { VERCEL_TOKEN: 'tok', VERCEL_TEAM_ID: 'team_1', VERCEL_PROJECT_ID: 'prj_1' }

function configOf(home: string): unknown {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
}

describe('setup flags', () => {
  it('saves every setting to config.json', async () => {
    const run = await runCli(
      [
        'setup',
        '--image',
        'my-repo:v1',
        '--vcpus',
        '4',
        '--timeout-minutes',
        '90',
        '--region',
        'fra1',
      ],
      { env: CREDENTIALS },
    )
    expect(run.code).toBe(0)
    expect(configOf(run.home)).toEqual({
      image: 'my-repo:v1',
      vcpus: 4,
      timeoutMinutes: 90,
      region: 'fra1',
    })
  })

  it('keeps earlier settings that a later setup does not mention', async () => {
    const first = await runCli(['setup', '--region', 'sfo1', '--vcpus', '2'], { env: CREDENTIALS })
    const second = await runCli(['setup', '--vcpus', '4'], {
      env: CREDENTIALS,
      userHome: first.userHome,
    })
    expect(second.code).toBe(0)
    expect(configOf(second.home)).toEqual({ region: 'sfo1', vcpus: 4 })
  })

  it.each([
    [['--vcpus', 'many'], 'vcpus must be a positive whole number'],
    [['--vcpus', '0'], 'vcpus must be a positive whole number'],
    [['--timeout-minutes', '1.5'], 'timeoutMinutes must be a positive whole number'],
    [['--memory-mb', '3000'], 'memoryMb must be a multiple of 2048'],
    [['--vcpus', '2', '--memory-mb', '2048'], 'does not match 2 vCPUs'],
    [['--region', 'eu west'], 'region must be text without spaces'],
    [['--colour', 'red'], 'unknown option --colour'],
    [['--image'], '--image needs a value'],
  ])('rejects %j', async (flags, message) => {
    const run = await runCli(['setup', ...flags], { env: CREDENTIALS })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain(message)
    expect(() => configOf(run.home)).toThrow()
  })
})

describe('config.json', () => {
  it('names the file and the field when a value is invalid', () => {
    expect(() => parseSettings({ vcpus: -1 }, '/h/config.json')).toThrow(
      '/h/config.json: vcpus must be a positive whole number',
    )
    expect(() => parseSettings({ cpu: 1 }, '/h/config.json')).toThrow('unknown setting cpu')
    expect(() => parseSettings([], 'c')).toThrow('must hold a JSON object')
  })

  it('stops create before a sandbox exists when it is invalid', async () => {
    const sandboxes = fakeSandboxes({} as LocalSshd)
    const run = await runCli(['create'], {
      env: CREDENTIALS,
      sandboxes,
      beforeRun(userHome) {
        mkdirSync(join(userHome, '.vercel-orca'), { recursive: true })
        writeFileSync(join(userHome, '.vercel-orca', 'config.json'), '{"vcpus": 0}')
      },
    })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('vcpus must be a positive whole number')
    expect(sandboxes.created).toEqual([])
  })
})

describe('Vercel create parameters', () => {
  it('passes each setting to the creation call', () => {
    const params = sandboxCreateParams({
      name: 'orca-1',
      ports: [8080],
      settings: { image: 'my-repo:v1', vcpus: 4, timeoutMinutes: 90, region: 'fra1' },
    })
    expect(params).toMatchObject({
      name: 'orca-1',
      ports: [8080],
      image: 'my-repo:v1',
      region: 'fra1',
      timeout: 5_400_000,
      resources: { vcpus: 4 },
    })
  })

  it('derives the vCPUs from memory, 2048 MB each', () => {
    expect(toCreateParams({ memoryMb: 8192 }).resources).toEqual({ vcpus: 4 })
  })

  it('leaves Vercel defaults alone when nothing is set', () => {
    expect(toCreateParams({})).toEqual({})
  })

  it('keeps only the latest snapshot', () => {
    expect(sandboxCreateParams({ name: 'n', ports: [], settings: {} }).keepLastSnapshots).toEqual({
      count: 1,
    })
  })
})

describe('image support', () => {
  it('explains an image without apt-get', async () => {
    const sandboxes = fakeSandboxes({ user: 'u' } as LocalSshd, { failOn: 'command -v apt-get' })
    const session = await sandboxes.create({ name: 'n', ports: [], settings: {} })
    await expect(installSshBridge(session, { user: 'u', home: '/h' }, 'key')).rejects.toThrow(
      'only Debian and Ubuntu based images are supported',
    )
  })
})
