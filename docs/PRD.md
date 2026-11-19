# PRD: Vercel Sandbox for Orca

## Summary

Vercel Sandbox for Orca is an Orca plugin that runs a workspace inside its own [Vercel Sandbox](https://vercel.com/docs/sandbox) instead of on the local machine. Orca connects to the sandbox over SSH and runs its terminals and agents there. The person chooses per workspace: some workspaces run locally, others in a sandbox.

Sleeping the workspace stops the sandbox and keeps its files. Waking it resumes the sandbox where the files left off. Removing the workspace copies any unpushed work back to the local repository before the sandbox is deleted.

The design follows the [Prized Sandbox plugin](https://github.com/prized-dev/orca-prized-plugin) (Apache-2.0), which solves the same problem for another provider. The Orca side (recipe, Git handling, saving work on remove) carries over; the provider side (API, SSH transport, sleep) is new.

## Problem

- **Agents run on the person's machine.** Several agents in parallel compete for CPU, memory and ports, and they can touch anything on the machine.
- **Orca has no built-in way to run a workspace on Vercel.** Orca supports per-workspace environments through VM recipes, but there is no recipe for Vercel Sandbox.
- **Vercel Sandbox has no native SSH.** `sandbox connect` opens an interactive shell through Vercel's own channel. Orca needs a real SSH target, so the plugin has to build one.

## Goals

1. **Pick Vercel Sandbox when creating a workspace**, under Run on > Per-Workspace Environment, with no other change to how Orca works.
2. **A working workspace in one step:** create the sandbox, check out the exact commit and branch Orca picked, and hand Orca an SSH target it can use right away.
3. **Never lose work:** removing a workspace saves unpushed commits, uncommitted changes and the latest stash to the local repository first. If saving fails, the sandbox is kept.
4. **Pay only while working:** sleep stops the sandbox; nothing keeps running (or billing) once the workspace is asleep or Orca is closed.
5. **No credentials in the sandbox:** no Vercel token, no Git credentials, no SSH private key ever goes into it.
6. **Publishable in the Orca plugin directory** as a public project (`oscarbotteri/orca-vercel-sandbox`).

## Non-goals (for now)

- Keeping memory and running processes across sleep. Vercel stops a sandbox by snapshotting its filesystem, so a tmux session or a running agent does not survive sleep (a background process, an HTTP server and a tmux session did not survive a stop, see [ADR 0001](adr/0001-sandbox-stop-resume-behavior.md)).
- Managing Vercel accounts, teams, projects or billing.
- Other sandbox providers.
- Signing agents in automatically. Claude Code or Codex are signed in from the workspace terminal the first time.
- Orca's port forwarding. Dev servers are reached through the sandbox's published URLs instead.
- Windows.

## Users and use cases

The primary user is a developer who runs several agents in parallel in Orca and wants some of them isolated from their machine.

| Use case | What they need |
| --- | --- |
| Run an agent on a task without it touching the local machine | Create a sandbox workspace, agent runs there over SSH |
| Stop for the day and pick up tomorrow | Sleep stops billing; wake brings back the files and branch |
| Push the agent's work | Copy its branch to the local repo and push with local Git credentials |
| Discard a workspace without losing anything by mistake | Remove saves unpushed work as local branches, then deletes |

## How it works

### Orca side

Orca runs a **VM recipe** (`vm-recipe.json`) with four commands: `create`, `suspend`, `resume` and `destroy`. Each calls a local adapter CLI, `vercel-orca`, installed in `~/.vercel-orca`.

- `create` prints one JSON object on stdout: an SSH target (`host`, `port`, `username`, `proxyCommand`), the project root inside the sandbox, and `userData.resourceId` with the sandbox name.
- `suspend`, `resume` and `destroy` read a lifecycle payload on stdin that contains that same result.
- Orca compares the SSH target on resume, so every field must stay the same for the life of a sandbox. The `proxyCommand` is therefore a fixed call to the adapter (`vercel-orca proxy <name>`), never a URL.

### Vercel side

The adapter uses the `@vercel/sandbox` SDK with an access token, team ID and project ID.

| Orca action | What the adapter does |
| --- | --- |
| Create | Creates a persistent sandbox with port 8080 published; uploads the commit as a Git bundle and checks out the branch in `~/work/<repo>`; sets Git name, email and an HTTPS `origin`; installs the SSH bridge; checks that the SSH connection works. Deletes the sandbox if any step fails or the person cancels. |
| Sleep | Marks the workspace asleep locally, then stops the sandbox. Vercel snapshots its filesystem. |
| Wake | Resumes the sandbox, starts `sshd` and the bridge again, and clears the asleep mark. |
| Remove | Wakes the sandbox if needed, saves unpushed work as local branches under `vercel-orca/saved/<name>/`, then deletes the sandbox and its snapshots. If saving fails, the sandbox stays and Orca reports the error. |

### SSH transport

Vercel only exposes HTTPS URLs for published ports, so SSH is carried over a WebSocket:

```
Orca ─ ssh ─ ProxyCommand: vercel-orca proxy <name>
                │  WebSocket (wss://<published-url>)
                ▼
        websocat in the sandbox (port 8080) ─ TCP ─ sshd (127.0.0.1:22)
```

- On create, the adapter generates an ed25519 key pair per sandbox on the local machine. Only the public key goes into the sandbox's `authorized_keys`.
- `sshd` listens on `127.0.0.1` only, with password login off. The published URL is public, so the key is the only way in.
- `vercel-orca proxy <name>`:
  - refuses while the workspace is asleep, so a reconnect never wakes it by accident;
  - resumes the sandbox if Vercel stopped it on timeout, and starts the bridge again;
  - looks up the current published URL and pipes stdin/stdout through a WebSocket (Node's built-in client, so nothing to install locally);
  - extends the sandbox timeout while the connection is open.
- Setup adds one `Include` line at the top of `~/.ssh/config` pointing to `~/.vercel-orca/ssh_config`, which holds one block per sandbox (`Host`, `User`, `IdentityFile`, `ProxyCommand`).

### Verified so far (November 18, 2026)

A manual test on a real sandbox (default image, Ubuntu 26.04, x86_64, user `ubuntu` with `sudo`) confirmed:

- `sshd` installs and runs in the sandbox.
- A published port carries WebSocket traffic: the SSH banner comes back through `websocat`.
- `ssh` with `ProxyCommand="websocat --binary wss://<url>"` and a dedicated key opens a shell as `ubuntu`.
- `sandbox config ports` publishes a port on a running sandbox without restarting it, and prints its URL.

## Done when

The plugin is ready to publish when a person can:

1. Run `setup` once, then pick **Vercel Sandbox** when creating a workspace in Orca.
2. Get a workspace whose terminals and agents run in the sandbox, on the branch Orca picked.
3. Sleep the workspace and see the sandbox stopped; wake it and find the same files and branch.
4. Copy the workspace's branch to the local repository with `vercel-orca pull` and push it.
5. Remove the workspace and find its unpushed work in local branches, with the sandbox and its snapshots deleted.

## Functional requirements

**Setup**

- `setup` checks Node, Git, OpenSSH and the Vercel credentials, installs the adapter in `~/.vercel-orca`, and asks before adding the `Include` line to `~/.ssh/config` (with a backup).
- `doctor` checks everything without creating anything, warns on the Hobby plan's short session limit, and lists sandboxes the plugin created that no workspace uses.
- `uninstall` removes the `Include` line and the adapter's files.
- Settings for new workspaces: image, vCPUs, memory, timeout, region (flags to `setup` or `~/.vercel-orca/config.json`).

**Lifecycle**

- `create` as described in How it works, cleaning up on failure or cancel.
- `suspend` stops the sandbox and blocks reconnects while asleep.
- `resume` resumes the sandbox and restarts `sshd` and the bridge.
- `destroy` saves work first, then deletes the sandbox with its snapshots; keeps the sandbox if saving fails.
- Sandboxes keep only their latest snapshot, so storage stays flat.

**Connection**

- SSH over WebSocket with a per-sandbox key, `sshd` on localhost, password login off.
- `proxy` refuses while asleep, resumes a sandbox stopped on timeout, and extends the timeout while connected.

**Git**

- Upload the exact commit as a Git bundle; no Git credential goes into the sandbox.
- `pull [name] [--as <branch>]` copies the workspace's branch into the local repository.
- Save on remove: branches with new commits, uncommitted changes, latest stash, detached HEAD, other worktrees.
- `list` shows the plugin's sandboxes and their workspaces.

## Ideas for later

Not planned, only noted:

- `ports <name> <port>` to publish a sandbox port for a dev server and print its URL.
- A custom image with `sshd` and `websocat` preinstalled, so create and wake are faster.
- Windows support.
- An egress allowlist per workspace, using the sandbox network policy.

## Non-functional requirements

**Performance**

- A new workspace is ready to use in under 2 minutes on the default image, excluding the time Orca takes to install its own server on first connection.
- Wake to a working SSH connection in under 30 seconds.

**Security**

- The Vercel token stays on the local machine: in memory and in API calls only, never in a file, log, command line or the sandbox.
- SSH private keys stay in `~/.vercel-orca` with `600` permissions and are deleted with their sandbox.
- No Git credentials in the sandbox. Pushing from inside it is the person's choice, with a token they create for that purpose.
- `~/.vercel-orca/lifecycle.log` records sandbox names, timings and errors only.

**Cost**

- Nothing runs once a workspace is asleep or removed: sandboxes stopped on sleep, deleted with their snapshots on remove.
- A sandbox the plugin created and lost track of (a create killed outright) shows up in `doctor`.

**Compatibility**

- Orca 1.4.245 or later, with Settings > Experimental > Cloud VM turned on.
- Node.js 24 or later, Git, OpenSSH.
- macOS and Linux.
- Vercel Pro or Enterprise for real use (up to 24 hours per session); Hobby works but stops after 45 minutes.

**Quality**

- Offline tests run the Orca recipe contract against a fake Vercel API and a local `sshd`, as the Prized plugin does.
- A live test runs create, sleep, wake, pull and remove against a real sandbox, opt-in with an env var.
- MIT license, with Apache-2.0 notices for anything taken from the Prized plugin.

## Open questions

Stop and resume behavior is settled in [ADR 0001](adr/0001-sandbox-stop-resume-behavior.md).

1. **How long does the timeout extension need to be** to keep a connected sandbox alive without letting a forgotten one run for a day?
2. **Default image or custom image?** Installing `sshd` and `websocat` on every create (packages survive a stop, so not on wake) is slower but needs no registry setup. `websocat` is not in the default image's `apt` repositories, so it would have to be downloaded as a binary.
3. **How should the plugin pick up Vercel credentials?** A token in the shell profile (as Prized does with its API key), or the `sandbox login` session.
