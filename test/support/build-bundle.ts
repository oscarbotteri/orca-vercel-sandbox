import { buildBundle } from '../../scripts/build.ts'

// Setup installs the bundle, so tests need it built from the current sources.
export default async function setup(): Promise<void> {
  await buildBundle('dist')
}
