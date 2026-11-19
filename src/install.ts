import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { UserError } from './errors.ts'
import type { AdapterHome } from './home.ts'

export const WRAPPER_NAME = 'vercel-orca'
export const BUNDLE_FILE = `${WRAPPER_NAME}.mjs`

function libDir(home: AdapterHome): string {
  return join(home.root, 'lib')
}

export function wrapperPath(home: AdapterHome): string {
  return join(home.bin, WRAPPER_NAME)
}

export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`
}

// Installs the bundled adapter next to a small launcher; the bundle carries its dependencies, so
// the checkout can move or go away afterwards.
export function installAdapter(home: AdapterHome, bundle: string): void {
  if (!existsSync(bundle)) {
    throw new UserError(
      `${bundle} is missing; run "npm run build" in the checkout and set up again`,
    )
  }
  const lib = libDir(home)
  // Start clean so files from an older install do not linger.
  rmSync(lib, { recursive: true, force: true })
  mkdirSync(lib, { recursive: true, mode: 0o700 })
  const installed = join(lib, BUNDLE_FILE)
  copyFileSync(bundle, installed)
  const wrapper = wrapperPath(home)
  writeFileSync(wrapper, `#!/bin/sh\nexec node ${shellQuote(installed)} "$@"\n`)
  chmodSync(wrapper, 0o755)
}

// Keys, state, the log and ssh_config stay: they belong to sandboxes that may still exist.
export function removeAdapterFiles(home: AdapterHome): void {
  rmSync(libDir(home), { recursive: true, force: true })
  rmSync(wrapperPath(home), { force: true })
}
