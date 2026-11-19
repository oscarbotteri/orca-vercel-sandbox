import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveHome } from '../src/home.ts'
import { BUNDLE_FILE, installAdapter, wrapperPath } from '../src/install.ts'

const BUILT_BUNDLE = join(import.meta.dirname, '..', 'dist', BUNDLE_FILE)

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'install-test-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('installAdapter', () => {
  it('fails clearly when the bundle was not built', () => {
    const root = tempDir()
    const home = resolveHome({ VERCEL_ORCA_HOME: join(root, 'home') })
    mkdirSync(home.bin, { recursive: true })

    expect(() => installAdapter(home, join(root, 'dist', BUNDLE_FILE))).toThrow(/npm run build/)
  })

  it('installs an adapter that runs after the checkout is moved or deleted', () => {
    const root = tempDir()
    const checkoutBundle = join(root, 'checkout', 'dist', BUNDLE_FILE)
    mkdirSync(join(root, 'checkout', 'dist'), { recursive: true })
    cpSync(BUILT_BUNDLE, checkoutBundle)
    const home = resolveHome({ VERCEL_ORCA_HOME: join(root, 'home') })
    mkdirSync(home.bin, { recursive: true })

    installAdapter(home, checkoutBundle)
    rmSync(join(root, 'checkout'), { recursive: true })

    const ran = spawnSync(wrapperPath(home), ['frobnicate'], { encoding: 'utf8', cwd: root })
    expect(ran.status).toBe(2)
    expect(ran.stderr).toContain('unknown command "frobnicate"')
  })
})
