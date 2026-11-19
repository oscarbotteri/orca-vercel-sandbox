# Sandbox stop and resume behavior

Status: accepted (November 19, 2026)

## Context

The plugin sleeps a workspace by stopping its sandbox and wakes it by resuming it. Three PRD open questions (since answered here and removed from the PRD) depended on what a real Vercel Sandbox keeps across that cycle: what survives besides files (and so where the bridge binary lives), whether the published URL is stable, and whether a published port must be set again.

## Findings

Measured on a real persistent sandbox (`@vercel/sandbox` 4.0.0, default image, port 3000 published at create) with one script: create, write marker files, start a `sleep` and an HTTP server in the background, `stop()`, then `Sandbox.get({ name, resume: true })` with no ports passed.

| Question | Answer | Evidence |
| --- | --- | --- |
| Does anything survive a stop besides files? | Files survive everywhere we wrote, including `/tmp`. The working directory and `$HOME` are both `/vercel`, which also survives. Processes do not: a background `sleep` and an HTTP server were both gone after resume. | Marker files in `/tmp`, `$HOME` and the working directory kept their content and timestamps; `pgrep` found the `sleep` before the stop and not after. |
| Is the published URL stable? | Yes. | `domain(3000)` returned the same `https://sb-….vercel.run` before the stop and after the resume. |
| Must a published port be set again? | No. The route was still there after resume without publishing it again. The server behind it was not: it answers 502 `SANDBOX_NOT_LISTENING` until started again, then answers 200 on the same URL. | `routes` still listed port 3000 after resume, with no ports passed to `Sandbox.get`; the fetch went 200, 502, 200 around the stop and the restart. |

The script was a one-off and is not kept in the repo; the steps above are the whole procedure.

## Decisions

- **The bridge binary lives in `/tmp`.** It survives a stop, so create can install it once and wake only restarts it, provided system-installed files (`sshd`, `websocat`) also survive; only files we wrote under `/tmp` and `/vercel` were tested. Running a binary from `/tmp` was not tested (a `noexec` mount would break it); the create step already checks the SSH connection works, so it would fail there.
- **Wake starts every process again.** `sshd` and the bridge are started on each wake; nothing can be assumed to still run.
- **The proxy keeps looking up the published URL on each connection.** The URL was stable in this test, but the lookup costs nothing and stays correct if Vercel changes this.
- **Wake does not publish the port again.** Create publishes it once.

## Limits of this spike

One short stop (seconds) and one sample of the URL, on a persistent sandbox. The test published port 3000; the recipe uses 8080, which makes no difference here. `$HOME` is `/vercel`, so the PRD's `~/work/<repo>` is `/vercel/work/<repo>`. We did not test a long stop, a sandbox stopped by its timeout, a non-persistent sandbox, or tmux or an agent process (only `sleep` and an HTTP server). Whether the route would survive without the create-time publish was not isolated.
