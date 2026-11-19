// Runs Orca's own VM recipe parser on vm-recipe.json. Invoked from the CI workflow, which checks
// out the Orca source at a pinned commit and runs this file from that checkout with tsx.
import { readFileSync } from 'node:fs'
import { parsePluginVmRecipeArtifact } from './src/shared/plugins/artifacts/plugin-vm-recipe-artifact'

const path = process.argv[2]
if (!path) throw new Error('usage: validate-recipe.ts <path to vm-recipe.json>')

const recipe = parsePluginVmRecipeArtifact(readFileSync(path, 'utf8'))
process.stdout.write(`vm-recipe.json is valid for Orca: ${recipe.id}\n`)
