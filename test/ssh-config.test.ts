import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addSandboxHost, removeSandboxHost, type SandboxHost } from '../src/ssh-config.ts'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vercel-orca-ssh-'))
  path = join(dir, 'ssh_config')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function host(name: string): SandboxHost {
  return {
    name,
    user: 'ubuntu',
    identityFile: `/keys/${name}`,
    proxyCommand: `"/bin/vercel-orca" proxy ${name}`,
  }
}

describe('per-sandbox SSH blocks', () => {
  it('writes Host, User, IdentityFile and ProxyCommand', () => {
    addSandboxHost(path, host('orca-a'))
    expect(readFileSync(path, 'utf8')).toBe(
      [
        '# vercel-orca begin orca-a',
        'Host orca-a',
        '  User ubuntu',
        '  IdentityFile /keys/orca-a',
        '  ProxyCommand "/bin/vercel-orca" proxy orca-a',
        '# vercel-orca end orca-a',
        '',
      ].join('\n'),
    )
  })

  it('keeps other sandboxes when one is added again or removed', () => {
    addSandboxHost(path, host('orca-a'))
    addSandboxHost(path, host('orca-b'))
    addSandboxHost(path, host('orca-a'))
    const both = readFileSync(path, 'utf8')
    expect(both.match(/^Host orca-a$/gm)).toHaveLength(1)
    expect(both).toContain('Host orca-b')

    removeSandboxHost(path, 'orca-a')
    const rest = readFileSync(path, 'utf8')
    expect(rest).not.toContain('orca-a')
    expect(rest).toContain('Host orca-b')
  })

  it('removing the last block leaves an empty file, and removing an unknown one changes nothing', () => {
    addSandboxHost(path, host('orca-a'))
    removeSandboxHost(path, 'orca-zzz')
    removeSandboxHost(path, 'orca-a')
    expect(readFileSync(path, 'utf8')).toBe('')
  })

  it('quotes an identity file whose path has spaces', () => {
    addSandboxHost(path, { ...host('orca-a'), identityFile: '/Users/Jane Doe/key' })
    expect(readFileSync(path, 'utf8')).toContain('  IdentityFile "/Users/Jane Doe/key"')
  })

  it('refuses values with a line break or an unsafe user', () => {
    expect(() =>
      addSandboxHost(path, { ...host('a'), identityFile: '/k\nProxyCommand x' }),
    ).toThrow('single line')
    expect(() => addSandboxHost(path, { ...host('a'), proxyCommand: 'x\r\nMatch all' })).toThrow(
      'single line',
    )
    expect(() => addSandboxHost(path, { ...host('a'), user: 'root extra' })).toThrow(
      'invalid ssh user',
    )
  })

  it('tolerates removing from a file that does not exist', () => {
    expect(() => removeSandboxHost(path, 'orca-a')).not.toThrow()
  })

  it('refuses a name that could inject other directives', () => {
    expect(() => addSandboxHost(path, host('x\n  ProxyCommand evil'))).toThrow(
      'invalid sandbox name',
    )
    writeFileSync(path, '')
    expect(() => removeSandboxHost(path, 'a b')).toThrow('invalid sandbox name')
  })
})
