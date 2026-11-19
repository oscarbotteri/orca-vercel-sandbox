# Resume starts sshd and the bridge only when they are down

Status: accepted (November 19, 2026)

## Context

`resume` starts `sshd` and the `websocat` bridge again, since nothing survives a stop (ADR 0001). A resume can also reach a sandbox that is already running: Orca running it twice, or an earlier resume that timed out after the sandbox came up. Starting `sshd -f` a second time fails with "Address already in use".

## Decision

Each process starts only if `pgrep -x` finds none by that name (`sshd`, `websocat`), so resume works whether the sandbox was stopped or already running. Resume always resumes the sandbox first, which does nothing to a running one.

## Consequences

A process that is running but wedged is left alone; resume does not restart it. Starting from a known state would need a kill first, which would drop live SSH sessions on a sandbox that is working.
