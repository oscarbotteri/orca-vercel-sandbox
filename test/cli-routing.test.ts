import { afterEach, describe, expect, it } from 'vitest'
import { cleanupHomes, runCli } from './support/run-cli.ts'

afterEach(cleanupHomes)

const payload = JSON.stringify({
  mode: 'destroy',
  recipeResult: { userData: { provider: 'vercel-sandbox', resourceId: 'orca-abc123' } },
})

const SUBCOMMANDS = [
  'create',
  'suspend',
  'resume',
  'destroy',
  'proxy',
  'setup',
  'uninstall',
  'doctor',
  'pull',
  'list',
]

describe('vercel-orca routing', () => {
  it.each(SUBCOMMANDS.filter((name) => !['setup', 'uninstall'].includes(name)))(
    'routes %s and says clearly that it is not implemented yet',
    async (name) => {
      const result = await runCli([name, 'orca-abc123'], { stdin: payload })
      expect(result.code).toBe(1)
      expect(result.stderr).toContain(`vercel-orca ${name} is not implemented yet`)
    },
  )

  it('prints nothing on stdout when a command fails', async () => {
    const result = await runCli(['create'])
    expect(result.stdout).toBe('')
  })

  it('rejects an unknown command and lists the known ones', async () => {
    const result = await runCli(['frobnicate'])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('unknown command "frobnicate"')
    for (const name of SUBCOMMANDS) expect(result.stderr).toContain(name)
  })

  it('rejects a missing command', async () => {
    const result = await runCli([])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('usage: vercel-orca <command>')
  })

  it.each(['suspend', 'resume', 'destroy'])(
    'reads the lifecycle payload for %s and names its sandbox in the log',
    async (name) => {
      const result = await runCli([name], { stdin: payload })
      expect(result.readLog()).toContain('orca-abc123')
    },
  )

  it('refuses a lifecycle payload that is empty', async () => {
    const result = await runCli(['suspend'], { stdin: '' })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('no lifecycle payload')
  })

  it('refuses a lifecycle payload that is not JSON', async () => {
    const result = await runCli(['resume'], { stdin: 'nope' })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('not JSON')
  })

  it('refuses a lifecycle payload that names no sandbox', async () => {
    const result = await runCli(['destroy'], { stdin: '{"recipeResult":{}}' })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('names no sandbox')
  })

  it('does not take the SSH host for the sandbox', async () => {
    const stdin = JSON.stringify({
      recipeResult: { connection: { target: { host: 'orca-fromhost' } } },
    })
    const result = await runCli(['suspend'], { stdin })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('names no sandbox')
  })

  it('refuses an empty resourceId even when the SSH host looks valid', async () => {
    const stdin = JSON.stringify({
      recipeResult: {
        userData: { resourceId: '' },
        connection: { target: { host: 'orca-fromhost' } },
      },
    })
    const result = await runCli(['suspend'], { stdin })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('names no sandbox')
  })
})
