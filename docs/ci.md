# Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`. Each check is its own job, so a failure names what broke, and `fail-fast` is off so one failure does not hide another.

| Check               | What it runs                                                                  |
| ------------------- | ----------------------------------------------------------------------------- |
| `format:check`      | `npm run format:check`                                                        |
| `lint`              | `npm run lint`                                                                |
| `typecheck`         | `npm run typecheck`                                                           |
| `test:coverage`     | `npm run test:coverage`: tests plus an 80% floor on statements, branches, functions and lines |
| `build`             | `npm run build`, then runs the bundle with `node_modules` removed |
| `recipe validation` | Orca's own recipe parser on `vm-recipe.json`                                  |
| `PR title`          | Conventional Commits with the types and scopes of `.claude/skills/commit-pr/SKILL.md` |
| `secret scan`       | gitleaks over the full history                                                |

Notes:

- Coverage covers `src/` only, not the fakes in `test/support/`. The threshold lives in `vitest.config.ts`, so the command fails the same way locally and in CI.
- The live sandbox test needs `VERCEL_ORCA_LIVE_TEST`, which CI never sets, so it is skipped.
- Recipe validation checks out the Orca source at the commit in `ORCA_REF` (in the workflow). To bump it, pick a newer commit of `stablyai/orca` and confirm the job still passes.
- Superseded runs on the same pull request are cancelled (pushes to `main` always finish), and the token is read-only.
- The `test:coverage` task builds the bundle first (a vitest global setup), since `setup` installs it.
