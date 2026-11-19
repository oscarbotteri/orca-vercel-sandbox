import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const RECIPE_PHASES = ['create', 'suspend', 'resume', 'destroy'] as const
export type RecipePhase = (typeof RECIPE_PHASES)[number]

export interface VmRecipe {
  schemaVersion: number
  id: string
  checkoutMode: string
  create: string
  suspend: string
  resume: string
  destroy: string
}

export interface PhaseResult {
  code: number | null
  stdout: string
  stderr: string
}

export function readRecipe(): VmRecipe {
  return JSON.parse(readFileSync(join(REPO, 'vm-recipe.json'), 'utf8')) as VmRecipe
}

export interface OrcaHost {
  // The $HOME Orca's shell sees; the adapter lives in <home>/.vercel-orca.
  home: string
  adapterHome: string
  runPhase(phase: RecipePhase, stdin?: string, env?: Record<string, string>): Promise<PhaseResult>
  dispose(): void
}

// Stands in for Orca's recipe runner: each phase is a command line run by `sh -c`, with the
// lifecycle payload on stdin. A shim in $HOME/.vercel-orca/bin plays the installed adapter.
export function createOrcaHost(): OrcaHost {
  const home = mkdtempSync(join(tmpdir(), 'orca-host-'))
  const adapterHome = join(home, '.vercel-orca')
  const bin = join(adapterHome, 'bin')
  mkdirSync(bin, { recursive: true })
  const shim = join(bin, 'vercel-orca')
  writeFileSync(shim, `#!/bin/sh\nexec node "${join(REPO, 'src', 'cli.ts')}" "$@"\n`)
  chmodSync(shim, 0o755)
  const recipe = readRecipe()

  return {
    home,
    adapterHome,
    runPhase(phase, stdin = '', env = {}) {
      return new Promise((resolvePhase, reject) => {
        const child = spawn('sh', ['-c', recipe[phase]], {
          env: { PATH: process.env.PATH ?? '', HOME: home, ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk
        })
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk
        })
        child.on('error', reject)
        child.on('close', (code) => resolvePhase({ code, stdout, stderr }))
        child.stdin.end(stdin)
      })
    },
    dispose: () => rmSync(home, { recursive: true, force: true }),
  }
}
