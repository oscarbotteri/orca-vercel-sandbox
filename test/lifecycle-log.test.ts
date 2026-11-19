import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLogger } from '../src/logger.ts'
import { cleanupHomes, runCli } from './support/run-cli.ts'

afterEach(cleanupHomes)

function payloadFor(resourceId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ recipeResult: { userData: { resourceId } }, ...extra })
}

describe('lifecycle.log', () => {
  it('records the sandbox name, the outcome and a timing', async () => {
    const result = await runCli(['suspend'], { stdin: payloadFor('orca-abc123') })
    const log = result.readLog()
    expect(log).toMatch(/suspend sandbox=orca-abc123 started/)
    expect(log).toMatch(/suspend sandbox=orca-abc123 failed after \d+ms: .*not implemented yet/)
  })

  it('is created in the adapter home with the layout the other commands rely on', async () => {
    const result = await runCli(['doctor'])
    for (const dir of ['bin', 'keys', 'state']) {
      expect(statSync(join(result.home, dir)).isDirectory()).toBe(true)
    }
    expect(statSync(result.home).mode & 0o777).toBe(0o700)
    expect(statSync(join(result.home, 'lifecycle.log')).mode & 0o777).toBe(0o600)
  })

  it('tightens a log and adapter directories that already exist with loose permissions', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vercel-orca-loose-'))
    for (const dir of [home, join(home, 'keys')]) {
      mkdirSync(dir, { recursive: true })
      chmodSync(dir, 0o755)
    }
    writeFileSync(join(home, 'lifecycle.log'), '')
    chmodSync(join(home, 'lifecycle.log'), 0o644)

    await runCli(['doctor'], { env: { VERCEL_ORCA_HOME: home } })

    expect(statSync(home).mode & 0o777).toBe(0o700)
    expect(statSync(join(home, 'keys')).mode & 0o777).toBe(0o700)
    expect(statSync(join(home, 'lifecycle.log')).mode & 0o777).toBe(0o600)
  })

  it('never writes the Vercel token, to the log or to the terminal', async () => {
    const token = 'tok_Zk39sdf0QweRty'
    const result = await runCli(['suspend'], {
      env: { VERCEL_TOKEN: token },
      stdin: payloadFor(`orca-${token}`),
    })
    expect(result.readLog()).not.toContain(token)
    expect(result.stderr).not.toContain(token)
    expect(result.stdout).not.toContain(token)
  })
})

describe('logger redaction', () => {
  const messages: [string, string, string][] = [
    [
      'an SSH private key',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXk',
    ],
    [
      'a GitHub token',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'abcdefghijklmnopqrstuvwxyz0123456789',
    ],
    [
      'Git credentials in a URL',
      'fetch https://alice:s3cretpass@github.com/o/r.git failed',
      's3cretpass',
    ],
    ['a bearer header', 'Authorization: Bearer abcDEF123456789xyz', 'abcDEF123456789xyz'],
    ['an exact secret value', 'token is hunter2-value', 'hunter2-value'],
  ]

  it.each(messages)('keeps %s out of the file and the terminal', (_label, message, needle) => {
    const file = join(mkdtempSync(join(tmpdir(), 'vercel-orca-log-')), 'lifecycle.log')
    let terminal = ''
    const logger = createLogger({
      file,
      stderr: {
        write: (text) => {
          terminal += text
        },
      },
      secrets: ['hunter2-value'],
    })
    logger.error(message)
    expect(readFileSync(file, 'utf8')).not.toContain(needle)
    expect(terminal).not.toContain(needle)
    expect(terminal).toContain('[redacted]')
  })

  it('leaves ordinary messages alone', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vercel-orca-log-')), 'lifecycle.log')
    createLogger({ file, stderr: { write: () => {} }, secrets: [] }).info(
      'create sandbox=orca-abc done in 12ms',
    )
    expect(readFileSync(file, 'utf8')).toContain('create sandbox=orca-abc done in 12ms')
  })
})
