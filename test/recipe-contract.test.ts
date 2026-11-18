import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOrcaHost, type OrcaHost, RECIPE_PHASES, readRecipe } from './support/orca-recipe.ts'

let orca: OrcaHost

beforeEach(() => {
  orca = createOrcaHost()
})
afterEach(() => orca.dispose())

describe('vm-recipe.json', () => {
  it('provisions a root and wires each phase to the adapter', () => {
    const recipe = readRecipe()
    expect(recipe.checkoutMode).toBe('provisioned-root')
    for (const phase of RECIPE_PHASES) {
      expect(recipe[phase]).toBe(`"$HOME/.vercel-orca/bin/vercel-orca" ${phase}`)
    }
  })

  it.each(['suspend', 'resume', 'destroy'] as const)(
    'phase %s reaches the adapter and hands it the lifecycle payload from stdin',
    async (phase) => {
      const stdin = JSON.stringify({
        mode: phase,
        recipeResult: { userData: { resourceId: 'orca-e2e1' } },
      })
      const result = await orca.runPhase(phase, stdin)
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain(`vercel-orca ${phase} is not implemented yet`)
      expect(readFileSync(join(orca.adapterHome, 'lifecycle.log'), 'utf8')).toContain(
        `${phase} sandbox=orca-e2e1`,
      )
    },
  )

  it('phase create reaches the adapter and prints nothing on stdout when it fails', async () => {
    const result = await orca.runPhase('create')
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('vercel-orca create is not implemented yet')
  })
})
