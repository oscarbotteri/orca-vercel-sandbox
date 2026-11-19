# Vercel Sandbox for Orca

An [Orca](https://github.com/stablyai/orca) plugin that runs a workspace in its own [Vercel Sandbox](https://vercel.com/docs/sandbox) instead of on your machine. Orca reaches the sandbox over SSH and runs its terminals and agents there.

> Work in progress: nothing is implemented yet. See [`docs/PRD.md`](docs/PRD.md) for the design.

## Requirements

- Orca 1.4.245 or later, with Settings > Experimental > Cloud VM on
- Node.js 24 or later, Git, OpenSSH
- A Vercel account (Pro or Enterprise for real use)
- macOS or Linux

## Development

```
nvm use
npm ci
npm run verify
```

### Live test

`test/live.test.ts` runs create, sleep, wake, pull and remove against a real Vercel Sandbox. It costs money, so it is skipped unless `VERCEL_ORCA_LIVE_TEST` is set. It needs the same credentials as the adapter and deletes its sandbox even when a step fails.

```
export VERCEL_TOKEN=... VERCEL_TEAM_ID=... VERCEL_PROJECT_ID=...
VERCEL_ORCA_LIVE_TEST=1 npx vitest run test/live.test.ts
```

## License

MIT. See [LICENSE](LICENSE).
