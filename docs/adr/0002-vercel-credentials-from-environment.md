# Vercel credentials come from the environment

Status: accepted (November 19, 2026)

## Context

The adapter calls the Vercel API through `@vercel/sandbox`, which needs an access token, a team ID and a project ID. The open question was whether to read them from the shell profile or from the session `sandbox login` leaves behind.

## Decision

The adapter reads `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` from its environment, which the person exports in their shell profile. All three are required.

- **Resolved before any API call.** A missing or malformed value (blank, or holding whitespace or control characters) fails at once with one message naming every problem variable.
- **The token stays in memory.** It is read from the environment and is already registered with the logger's redaction (`main.ts` passes `VERCEL_TOKEN` as a secret). Commands that call the API take it from `context.credentials()` and pass it to the SDK. No message repeats a value, and the adapter never writes it to a file, a command line or the sandbox.
- **Not the `sandbox login` session.** That session lives in the Vercel CLI's `auth.json`, a file the adapter does not own (the SDK's schema for it holds only `token`, `refreshToken` and `expiresAt`): its token expires and is refreshed by the CLI, and it does not carry a team or project. Reading it would also put the adapter in charge of refreshing a token it did not create.

## Consequences

Setup is one explicit step: export three variables. `setup` and `doctor`, when built, can check them with the same resolver. Tokens are not checked against the API here, so a revoked token surfaces as the API's own error on first use.
