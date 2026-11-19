import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { UserError } from './errors.ts'
import type { AdapterHome } from './home.ts'

export const WRAPPER_NAME = 'vercel-orca'

function libDir(home: AdapterHome): string {
  return join(home.root, 'lib')
}

export function wrapperPath(home: AdapterHome): string {
  return join(home.bin, WRAPPER_NAME)
}

export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`
}

// Copies the adapter's sources next to a small launcher; Node runs the TypeScript directly.
export function installAdapter(home: AdapterHome, sourceDir: string): void {
  const lib = libDir(home)
  // Start clean so files dropped from the sources do not linger.
  rmSync(lib, { recursive: true, force: true })
  mkdirSync(lib, { recursive: true, mode: 0o700 })
  for (const file of readdirSync(sourceDir).filter((name) => name.endsWith('.ts'))) {
    copyFileSync(join(sourceDir, file), join(lib, file))
  }
  // The sources import @vercel/sandbox, which Node resolves from the installed copy upward. Until
  // the adapter ships its own dependencies, share the checkout's, so it must stay in place.
  const modules = join(sourceDir, '..', 'node_modules')
  if (!existsSync(modules)) {
    throw new UserError(
      `${modules} is missing, so the adapter could not load its dependencies; run "npm ci" in the checkout and set up again`,
    )
  }
  symlinkSync(modules, join(lib, 'node_modules'), 'dir')
  const wrapper = wrapperPath(home)
  writeFileSync(wrapper, `#!/bin/sh\nexec node ${shellQuote(join(lib, 'cli.ts'))} "$@"\n`)
  chmodSync(wrapper, 0o755)
}

// Keys, state, the log and ssh_config stay: they belong to sandboxes that may still exist.
export function removeAdapterFiles(home: AdapterHome): void {
  rmSync(libDir(home), { recursive: true, force: true })
  rmSync(wrapperPath(home), { force: true })
}
