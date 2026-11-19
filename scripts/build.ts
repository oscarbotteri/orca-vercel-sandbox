import { build } from 'esbuild'
import { BUNDLE_FILE } from '../src/install.ts'

// One self-contained file: the adapter's sources and @vercel/sandbox, so nothing is resolved at run time.
export async function buildBundle(outDir: string): Promise<void> {
  await build({
    entryPoints: ['src/cli.ts'],
    outfile: `${outDir}/${BUNDLE_FILE}`,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    // Bundled CommonJS dependencies call require(), which ESM output does not define.
    banner: {
      js: "import { createRequire } from 'node:module';const require = createRequire(import.meta.url);",
    },
    logLevel: 'warning',
  })
}

if (import.meta.main) await buildBundle('dist')
