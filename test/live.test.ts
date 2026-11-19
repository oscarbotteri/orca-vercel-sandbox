import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveCredentials } from '../src/credentials.ts'
import { SANDBOX_PREFIX, type SandboxProvider, vercelSandboxes } from '../src/sandbox-session.ts'
import { cleanupGitDirs, git, makeRepo } from './support/git-repo.ts'
import { createOrcaHost, type OrcaHost } from './support/orca-recipe.ts'

// Runs against a real Vercel Sandbox, which costs money: nothing here runs unless this is set.
// It also needs VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID, as the adapter does.
const LIVE = 'VERCEL_ORCA_LIVE_TEST'
const FIVE_MINUTES = 5 * 60_000
const run = promisify(execFile)

describe.skipIf(!process.env[LIVE])('live sandbox lifecycle', () => {
  let host: OrcaHost
  let sandboxes: SandboxProvider
  let env: Record<string, string>
  let name: string | undefined

  beforeAll(() => {
    const credentials = resolveCredentials(process.env)
    env = {
      VERCEL_TOKEN: credentials.token,
      VERCEL_TEAM_ID: credentials.teamId,
      VERCEL_PROJECT_ID: credentials.projectId,
    }
    sandboxes = vercelSandboxes(credentials, { fetch, webSocket: (url) => new WebSocket(url) })
    host = createOrcaHost()
    // ssh records the sandbox's host key under ~/.ssh, which a person's home already has.
    mkdirSync(join(host.home, '.ssh'), { mode: 0o700 })
  })

  // Whatever failed above, the sandbox must not be left running and billing.
  afterAll(async () => {
    try {
      if (name && (await sandboxes.list()).some((sandbox) => sandbox.name === name)) {
        await (await sandboxes.get(name)).delete()
      }
    } finally {
      host?.dispose()
      cleanupGitDirs()
    }
  })

  function adapter(args: string[], cwd: string) {
    const shim = join(host.adapterHome, 'bin', 'vercel-orca')
    return run(shim, args, { cwd, env: { PATH: process.env.PATH, HOME: host.home, ...env } })
  }

  it(
    'creates, sleeps, wakes, pulls and removes a sandbox',
    async () => {
      const repo = makeRepo()
      function payload(): string {
        return JSON.stringify({ recipeResult: { userData: { resourceId: name } } })
      }

      const created = await host.runPhase('create', '', {
        ...env,
        ORCA_REPO_PATH: repo.path,
        ORCA_REPO_BRANCH: 'main',
        ORCA_REPO_REF_HEAD: repo.head,
      })
      expect(created.stderr).not.toContain('failed')
      expect(created.code).toBe(0)
      const result = JSON.parse(created.stdout)
      name = result.userData.resourceId
      expect(name).toMatch(new RegExp(`^${SANDBOX_PREFIX}`))

      // Work only the sandbox has, which sleep must keep and pull and remove must find.
      const session = await sandboxes.get(name as string)
      const root = result.projectRoot
      await session.exec(
        `git -C ${root} checkout -b live-work && echo live > ${root}/live.txt && git -C ${root} add live.txt` +
          ` && git -C ${root} -c user.name=Live -c user.email=live@example.com commit -m live-work`,
      )

      const slept = await host.runPhase('suspend', payload(), env)
      expect(slept.code, slept.stderr).toBe(0)

      const woke = await host.runPhase('resume', payload(), env)
      expect(woke.code, woke.stderr).toBe(0)

      await adapter(['pull', '--as', 'live-pull'], repo.path)
      expect(git(repo.path, 'show', 'live-pull:live.txt')).toBe('live')

      const removed = await host.runPhase('destroy', payload(), env)
      expect(removed.code, removed.stderr).toBe(0)
      const remaining = await sandboxes.list()
      expect(remaining.map((sandbox) => sandbox.name)).not.toContain(name)
      // The unpushed commit was saved locally before the sandbox went.
      expect(git(repo.path, 'branch', '--list', `vercel-orca/saved/${name}*`)).not.toBe('')
    },
    4 * FIVE_MINUTES,
  )
})
