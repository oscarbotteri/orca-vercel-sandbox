import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupHomes, runCli } from './support/run-cli.ts'

afterEach(cleanupHomes)

const CREDENTIALS = {
  VERCEL_TOKEN: 'tok',
  VERCEL_TEAM_ID: 'team_1',
  VERCEL_PROJECT_ID: 'prj_1',
}

function sshConfigOf(userHome: string): string {
  return join(userHome, '.ssh', 'config')
}

function seedSshConfig(userHome: string, text: string): void {
  mkdirSync(join(userHome, '.ssh'), { mode: 0o700 })
  writeFileSync(sshConfigOf(userHome), text, { mode: 0o600 })
}

function backups(userHome: string): string[] {
  return readdirSync(join(userHome, '.ssh')).filter((name) => name.endsWith('.bak'))
}

describe('vercel-orca setup', () => {
  it('names every missing prerequisite and changes nothing', async () => {
    const result = await runCli(['setup'], {
      env: { PATH: '', VERCEL_TOKEN: '', VERCEL_TEAM_ID: '', VERCEL_PROJECT_ID: '' },
      confirm: true,
    })
    expect(result.code).toBe(1)
    for (const missing of [
      'Git',
      'OpenSSH',
      'VERCEL_TOKEN',
      'VERCEL_TEAM_ID',
      'VERCEL_PROJECT_ID',
    ]) {
      expect(result.stderr).toContain(missing)
    }
    expect(existsSync(join(result.userHome, '.ssh'))).toBe(false)
    expect(existsSync(join(result.home, 'bin', 'vercel-orca'))).toBe(false)
  })

  it('installs a runnable adapter wrapper', async () => {
    const result = await runCli(['setup'], { env: CREDENTIALS, confirm: true })
    expect(result.code).toBe(0)
    const wrapper = join(result.home, 'bin', 'vercel-orca')
    expect(readFileSync(wrapper, 'utf8')).toContain(join(result.home, 'lib', 'cli.ts'))
    expect(existsSync(join(result.home, 'lib', 'main.ts'))).toBe(true)
    const ran = spawnSync(wrapper, ['list'], { encoding: 'utf8', env: result.env })
    expect(ran.stderr).toContain('vercel-orca list is not implemented yet')
  })

  it('asks before touching ~/.ssh/config and leaves it alone when declined', async () => {
    const result = await runCli(['setup'], { env: CREDENTIALS, confirm: false })
    expect(result.code).toBe(0)
    expect(result.questions).toHaveLength(1)
    expect(existsSync(sshConfigOf(result.userHome))).toBe(false)
  })

  it('backs up the existing config, then adds the Include line at the top', async () => {
    const original = 'Host github.com\n  User git\n'
    const result = await runCli(['setup'], {
      env: CREDENTIALS,
      confirm: true,
      beforeRun: (userHome) => seedSshConfig(userHome, original),
    })
    expect(result.code).toBe(0)
    const include = `Include ${join(result.home, 'ssh_config')}`
    expect(readFileSync(sshConfigOf(result.userHome), 'utf8')).toBe(`${include}\n\n${original}`)
    const [backup] = backups(result.userHome)
    expect(backup).toBeDefined()
    expect(readFileSync(join(result.userHome, '.ssh', backup ?? ''), 'utf8')).toBe(original)
  })

  it('is idempotent: a second run neither asks nor rewrites nor backs up again', async () => {
    const first = await runCli(['setup'], {
      env: CREDENTIALS,
      confirm: true,
      beforeRun: (userHome) => seedSshConfig(userHome, 'Host a\n'),
    })
    const afterFirst = readFileSync(sshConfigOf(first.userHome), 'utf8')
    const second = await runCli(['setup'], {
      env: CREDENTIALS,
      confirm: true,
      userHome: first.userHome,
    })
    expect(second.questions).toEqual([])
    expect(readFileSync(sshConfigOf(first.userHome), 'utf8')).toBe(afterFirst)
    expect(backups(first.userHome)).toHaveLength(1)
  })

  it('creates the config when there is none', async () => {
    const result = await runCli(['setup'], { env: CREDENTIALS, confirm: true })
    expect(readFileSync(sshConfigOf(result.userHome), 'utf8')).toBe(
      `Include ${join(result.home, 'ssh_config')}\n`,
    )
  })
})

describe('vercel-orca uninstall', () => {
  it('restores a config that began with a blank line and recognises an indented Include', async () => {
    const original = '\nHost a\n'
    const installed = await runCli(['setup'], {
      env: CREDENTIALS,
      confirm: true,
      beforeRun: (userHome) => seedSshConfig(userHome, original),
    })
    const indented = readFileSync(sshConfigOf(installed.userHome), 'utf8').replace(
      /^Include/,
      '  Include',
    )
    writeFileSync(sshConfigOf(installed.userHome), indented)
    const again = await runCli(['setup'], {
      env: CREDENTIALS,
      confirm: true,
      userHome: installed.userHome,
    })
    expect(again.questions).toEqual([])
    await runCli(['uninstall'], { userHome: installed.userHome })
    expect(readFileSync(sshConfigOf(installed.userHome), 'utf8')).toBe(original)
  })

  it('restores the SSH config byte for byte and removes the adapter files', async () => {
    const original = 'Host github.com\n  User git\n'
    const installed = await runCli(['setup'], {
      env: CREDENTIALS,
      confirm: true,
      beforeRun: (userHome) => seedSshConfig(userHome, original),
    })
    const result = await runCli(['uninstall'], { userHome: installed.userHome })
    expect(result.code).toBe(0)
    expect(readFileSync(sshConfigOf(result.userHome), 'utf8')).toBe(original)
    expect(existsSync(join(result.home, 'bin', 'vercel-orca'))).toBe(false)
    expect(existsSync(join(result.home, 'lib'))).toBe(false)
    expect(existsSync(join(result.home, 'ssh_config'))).toBe(false)
  })

  it('removes a config that setup created and that holds nothing else', async () => {
    const installed = await runCli(['setup'], { env: CREDENTIALS, confirm: true })
    await runCli(['uninstall'], { userHome: installed.userHome })
    expect(existsSync(sshConfigOf(installed.userHome))).toBe(false)
  })

  it('keeps an Include line the user added by hand, and ssh_config with its sandbox blocks', async () => {
    const result = await runCli(['setup'], {
      env: CREDENTIALS,
      confirm: false,
      beforeRun: (userHome) =>
        seedSshConfig(
          userHome,
          `Include ${join(userHome, '.vercel-orca', 'ssh_config')}\n\nHost a\n`,
        ),
    })
    writeFileSync(join(result.home, 'ssh_config'), '# vercel-orca begin orca-a\n')
    const before = readFileSync(sshConfigOf(result.userHome), 'utf8')
    await runCli(['uninstall'], { userHome: result.userHome })
    expect(readFileSync(sshConfigOf(result.userHome), 'utf8')).toBe(before)
    expect(readFileSync(join(result.home, 'ssh_config'), 'utf8')).toContain('orca-a')
  })

  it('reinstalling drops files that are no longer in the sources', async () => {
    const result = await runCli(['setup'], { env: CREDENTIALS, confirm: false })
    writeFileSync(join(result.home, 'lib', 'stale.ts'), '')
    await runCli(['setup'], { env: CREDENTIALS, confirm: false, userHome: result.userHome })
    expect(existsSync(join(result.home, 'lib', 'stale.ts'))).toBe(false)
  })

  it('succeeds when nothing was installed', async () => {
    const result = await runCli(['uninstall'])
    expect(result.code).toBe(0)
  })
})
