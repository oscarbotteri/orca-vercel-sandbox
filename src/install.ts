import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterHome } from './home.ts'

export const WRAPPER_NAME = 'vercel-orca'

function libDir(home: AdapterHome): string {
  return join(home.root, 'lib')
}

export function wrapperPath(home: AdapterHome): string {
  return join(home.bin, WRAPPER_NAME)
}

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`
}

// Copies the adapter's sources next to a small launcher; Node runs the TypeScript directly.
export function installAdapter(home: AdapterHome, sourceDir: string): void {
  const lib = libDir(home)
  mkdirSync(lib, { recursive: true, mode: 0o700 })
  for (const file of readdirSync(sourceDir).filter((name) => name.endsWith('.ts'))) {
    copyFileSync(join(sourceDir, file), join(lib, file))
  }
  const wrapper = wrapperPath(home)
  writeFileSync(wrapper, `#!/bin/sh\nexec node ${shellQuote(join(lib, 'cli.ts'))} "$@"\n`)
  chmodSync(wrapper, 0o755)
}

// Keys, state and the log stay: they belong to sandboxes that may still exist.
export function removeAdapterFiles(home: AdapterHome): void {
  rmSync(libDir(home), { recursive: true, force: true })
  rmSync(wrapperPath(home), { force: true })
  rmSync(home.sshConfig, { force: true })
}
