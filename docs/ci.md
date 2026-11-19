# Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`. Each check is its own job, so a failure names what broke, and `fail-fast` is off so one failure does not hide another.

| Check               | What it runs                                                                  |
| ------------------- | ----------------------------------------------------------------------------- |
| `format:check`      | `npm run format:check`                                                        |
| `lint`              | `npm run lint`                                                                |
| `typecheck`         | `npm run typecheck`                                                           |
| `test:coverage`     | `npm run test:coverage`: tests plus an 80% floor on statements, branches, functions and lines |
| `recipe validation` | Orca's own recipe parser on `vm-recipe.json`                                  |
| `PR title`          | Conventional Commits with the types and scopes of `.claude/skills/commit-pr/SKILL.md` |
| `secret scan`       | gitleaks over the full history                                                |

Notes:

- Coverage covers `src/` only, not the fakes in `test/support/`. The threshold lives in `vitest.config.ts`, so the command fails the same way locally and in CI.
- The live sandbox test needs `VERCEL_ORCA_LIVE_TEST`, which CI never sets, so it is skipped.
- Recipe validation checks out the Orca source at the commit in `ORCA_REF` (in the workflow). To bump it, pick a newer commit of `stablyai/orca` and confirm the job still passes.
- Superseded runs on the same pull request are cancelled (pushes to `main` always finish), and the token is read-only.
- There is no build check yet; the bundling issue (#26) adds one.

## Manual setup: the `main` ruleset

The workflow cannot change repository settings. The repo owner creates this once, under Settings → Rules → Rulesets → New branch ruleset:

- Target: the default branch (`main`). Enforcement: Active.
- Require a pull request before merging.
- Require status checks to pass, with these exact names: `format:check`, `lint`, `typecheck`, `test:coverage`, `recipe validation`, `PR title`, `secret scan`.
- Block force pushes (and deletion of `main`).

Also set Settings → General → Pull Requests to allow squash merging only, with the default commit message set to "Pull request title". The PR title check relies on it.

Keep the job names in `ci.yml` stable; renaming one makes the rule wait for a check that never reports.
