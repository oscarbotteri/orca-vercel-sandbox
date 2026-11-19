import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveHome } from '../src/home.ts'
import { installAdapter } from '../src/install.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('installAdapter', () => {
  it('fails clearly when the checkout has no node_modules to link', () => {
    const root = mkdtempSync(join(tmpdir(), 'install-test-'))
    dirs.push(root)
    const sourceDir = join(root, 'checkout', 'src')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'cli.ts'), '')
    const home = resolveHome({ VERCEL_ORCA_HOME: join(root, 'home') })
    mkdirSync(home.bin, { recursive: true })

    expect(() => installAdapter(home, sourceDir)).toThrow(/npm ci/)
  })
})
