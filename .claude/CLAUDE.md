# Vercel Sandbox for Orca — Agent Instructions

## Project Overview

An Orca plugin that runs a workspace in its own Vercel Sandbox. Orca runs a VM recipe (`vm-recipe.json`) whose `create`, `suspend`, `resume` and `destroy` commands call a local adapter CLI, `vercel-orca`, and reach the sandbox over SSH carried on a WebSocket. Product scope is in `docs/PRD.md`.

## Global conventions

- Prefer named function declarations over arrow function assignments
- Prefer `interface` for object shapes
- Use `type` for unions, intersections, and utility types
- Never use `any`; use `unknown` when the type cannot be determined
- No `console.*` in code; write through the adapter's logger. Only `vercel-orca create` prints its JSON result on stdout
- **Biome** is the single tool for formatting and linting — do not use ESLint or Prettier
- Prefer YAGNI, KISS, and DRY in that order
- Implement real behavior. Do not add fake data or temporary shortcuts just to satisfy a check
- Keep changes scoped to the request and the affected contracts
- Use descriptive kebab-case file names for new files
- Files under 500 lines, functions under 50

## Global Rules

- After completing any task, run `npm run verify` (typecheck, lint, format check, tests; fix formatting with `npm run format`)
- The Vercel token lives only in memory and API calls: never in a file, log, command line or the sandbox. No Git credentials and no SSH private key go into the sandbox
- Every field of the SSH target Orca receives must stay identical for the life of a sandbox; the `proxyCommand` is a fixed call to the adapter, never a URL
- Remove never deletes a sandbox before unpushed work is saved locally; if saving fails, the sandbox stays
- `lifecycle.log` records sandbox names, timings and errors only
- Keep commits focused and follow `.claude/skills/commit-pr/SKILL.md`: conventional format, no AI references
- Never commit secrets, dotenv files, tokens or private keys

## Quality Gates

- Run the narrowest useful test first, then broaden when shared behavior or public contracts changed
- Do not hide failing tests, lint, type or syntax errors
- Preserve public contracts (`vm-recipe.json`, adapter CLI commands and flags, the lifecycle payload) unless the change is intentional and the user accepted that scope
- Live tests against a real sandbox are opt-in through an env var and cost money: never run them unasked

## Commands

```
npm ci            # install
npm run verify    # typecheck, lint, format check, tests
npm test          # vitest
npm run format    # Biome, write
```

## Agent skills

### Issue tracker

Issues live in GitHub Issues (via the `gh` CLI) at `oscarbotteri/orca-vercel-sandbox`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Documentation

| File          | Topic                                                                           |
| ------------- | ------------------------------------------------------------------------------- |
| `docs/PRD.md` | What the plugin is, how it works, requirements, open questions                  |
| `docs/adr/`   | One file per decision (`NNNN-kebab-case-title.md`), added when a decision would surprise a future reader |
