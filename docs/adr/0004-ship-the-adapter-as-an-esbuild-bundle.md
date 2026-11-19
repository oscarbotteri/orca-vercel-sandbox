# The adapter ships as one esbuild bundle

Status: accepted (November 19, 2026)

## Context

`setup` used to copy `src/*.ts` into `~/.vercel-orca/lib`, and Node ran the TypeScript directly. That left no way to load `@vercel/sandbox`, so `setup` linked `lib/node_modules` to the checkout's. Moving or deleting the checkout, or running `npm ci` in it, broke every `vercel-orca` call, including the `proxyCommand` that ssh runs. A plugin installed from the Orca directory has no checkout to link to.

## Decision

`npm run build` bundles `src/cli.ts` and its dependencies with esbuild into `dist/vercel-orca.mjs` (ESM, Node 24 target, one file). `setup` copies that file into `lib/` and writes a launcher that runs it; there is no symlink, no `npm` call and no network access at setup. `setup` fails with a `npm run build` hint when the bundle is missing.

`npm run verify` and the tests keep running the TypeScript sources directly; only `setup` uses the bundle, and the test run builds it first.

Alternatives considered:

- **`npm install` at setup:** needs network and npm on the person's machine, and can fail halfway.
- **Copy `node_modules`:** thousands of files, and a platform-specific copy from a dev install.
- **A Node single executable:** heavier to build and sign per platform, for no gain over `node` which `setup` already requires.

## Consequences

`dist/` is not committed. Whatever publishes the plugin (#17) must build the bundle first. The bundle is about 3 MB, since it carries the SDK. Stack traces point into the bundle, not the sources.
