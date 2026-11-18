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

## License

MIT. See [LICENSE](LICENSE).
