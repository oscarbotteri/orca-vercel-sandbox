<!--
PR title (it becomes the squash commit subject):
  <type>(<scope>): <imperative summary> (#<issue>)
  e.g. feat(lifecycle): add the create command (#13)
Rules and allowed types/scopes: .claude/skills/commit-pr/SKILL.md

Fill every section. Delete an optional section only when it is empty.
Do not delete checklist items: mark them [x] or write "N/A" next to them.
-->

Closes #<issue>

<!-- Use "Refs #<issue>" for partial work, or "No issue: <reason>" for a chore without one.
     Then list the PRD sections this PR implements or changes
     and the ADRs it follows or adds; delete what does not apply. -->

PRD: <sections of docs/PRD.md> · ADR: [nnnn](docs/adr/nnnn-name.md)

## Summary

<!-- One to three sentences: what this PR does and why. -->

## What changed

<!-- One bullet per meaningful change. Lead with the thing (`src/cli.ts`, a command, a setting), then what it does. -->

-

## Acceptance criteria

<!-- Copied from the issue, or from the PRD PRD requirements when there is no issue.
     [x] when met, with the test or evidence that shows it.
     When not met, leave [ ] and say why and where it will be done. -->

- [ ]

## Verification

<!-- Only what you actually ran, with its result. Say what was NOT verified. -->

<!-- CI runs format:check, lint, typecheck, test:coverage, recipe validation, the PR title and a
     secret scan on every PR (docs/ci.md). List here what you ran yourself. -->

- [ ] `npm run typecheck`
- [ ] `npm run lint`, `npm run format:check`
- [ ] `npm run test:coverage` (<n> files, <n> tests; coverage stays at or above 80%)
- [ ] Live test against a real sandbox (opt-in env var) for lifecycle or proxy changes; N/A otherwise

## Notes for review (optional)

<!-- Decisions and trade-offs, deliberate differences from the PRD or architecture, known limits,
     merge order with other PRs, expected conflicts, manual steps for the repo owner. -->

## Out of scope (optional)

<!-- What is deliberately not done here, and the issue that tracks it. -->

## Screenshots (optional)

<!-- Terminal output or a short recording of the flow, when it helps. -->

## Checklist

- [ ] Title and every commit follow Conventional Commits, with no AI references
- [ ] Tests added or updated; recipe contract tests run against the fake Vercel API and a local `sshd`
- [ ] Docs updated (PRD, ADR) when behavior or a decision changed
- [ ] Public contracts (`vm-recipe.json`, adapter CLI flags, lifecycle payload, `create` output) are unchanged, or the change is called out in the notes
- [ ] The SSH target stays identical for the life of a sandbox
- [ ] No secrets, dotenv files, tokens or private keys; nothing credential-like goes into the sandbox or `lifecycle.log`
- [ ] Nothing from the PRD Non-goals
