import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { isAsleep } from './asleep.ts'
import type { Command, CommandContext } from './commands.ts'
import { UserError } from './errors.ts'
import { git } from './git-bundle.ts'
import { resolveHome } from './home.ts'
import { shellQuote } from './install.ts'
import { SANDBOX_NAME } from './lifecycle-payload.ts'
import type { SandboxSession } from './sandbox-session.ts'
import { readIdentity } from './sandbox-ssh.ts'
import { sandboxNames } from './ssh-keys.ts'

interface PullArgs {
  name?: string
  as?: string
}

function parsePullArgs(args: string[]): PullArgs {
  try {
    const { values, positionals } = parseArgs({
      args,
      options: { as: { type: 'string' } },
      allowPositionals: true,
    })
    if (positionals.length > 1) throw new UserError('pull takes at most one sandbox name')
    return { name: positionals[0], as: values.as }
  } catch (error) {
    if (error instanceof UserError) throw error
    throw new UserError(
      `usage: vercel-orca pull [name] [--as <branch>]: ${(error as Error).message}`,
    )
  }
}

// Without a name, the person has one sandbox to mean; with several, guessing could copy the wrong work.
function pickSandbox(given: string | undefined, env: NodeJS.ProcessEnv): string {
  if (given) {
    if (!SANDBOX_NAME.test(given)) throw new UserError(`invalid sandbox name "${given}"`)
    return given
  }
  const known = sandboxNames(resolveHome(env))
  if (known.length === 1) return known[0] as string
  throw new UserError(
    known.length === 0
      ? 'no sandbox to pull from: create a workspace first'
      : `name the sandbox to pull from: ${known.join(', ')}`,
  )
}

async function localBranchExists(
  repo: string,
  branch: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  return git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], env).then(
    () => true,
    () => false,
  )
}

// Git decides what a branch name is; a leading dash is refused since the name reaches a command line.
async function assertBranchName(
  repo: string,
  branch: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const valid =
    !branch.startsWith('-') &&
    (await git(repo, ['check-ref-format', '--branch', branch], env).then(
      () => true,
      () => false,
    ))
  if (!valid) throw new UserError(`unsupported branch name: ${branch}`)
}

// The sandbox checkout's current branch, or undefined when HEAD is detached.
async function sandboxBranch(
  session: SandboxSession,
  checkout: string,
): Promise<string | undefined> {
  const repo = shellQuote(checkout)
  try {
    await session.exec(`git -C ${repo} rev-parse --git-dir`)
  } catch (error) {
    throw new UserError(`sandbox ${session.name} has no checkout at ${checkout}`, { cause: error })
  }
  return (await session.exec(`git -C ${repo} branch --show-current`)).trim() || undefined
}

async function downloadBundle(
  session: SandboxSession,
  checkout: string,
  sandboxHome: string,
  ref: string,
): Promise<Buffer> {
  const file = `${sandboxHome}/pull.bundle`
  try {
    await session.exec(
      `git -C ${shellQuote(checkout)} bundle create --quiet ${shellQuote(file)} ${shellQuote(ref)}`,
    )
    return await session.readFile(file)
  } finally {
    await session.exec(`rm -f ${shellQuote(file)}`).catch(() => '')
  }
}

async function fetchBundle(
  repo: string,
  bundle: Buffer,
  refspec: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'vercel-orca-pull-'))
  try {
    const file = join(dir, 'pull.bundle')
    await writeFile(file, bundle)
    await git(repo, ['fetch', '--quiet', file, refspec], env)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Copies the sandbox checkout's branch into the local repository, so the person can push it with
// local Git credentials. An existing local branch is only replaced when the person named it with --as.
async function runPull(context: CommandContext): Promise<void> {
  const { env } = context
  const args = parsePullArgs(context.args)
  const repo = await git(context.cwd, ['rev-parse', '--show-toplevel'], env)
  const name = pickSandbox(args.name, env)
  if (isAsleep(resolveHome(env), name)) {
    throw new UserError(`sandbox ${name} is asleep; wake the workspace in Orca to pull`)
  }
  const session = await context.sandboxes().get(name, { resume: true })
  const { home } = await readIdentity(session)
  const checkout = `${home}/work/${basename(repo)}`
  const branch = await sandboxBranch(session, checkout)
  const target = args.as ?? branch
  if (!target)
    throw new UserError(`the sandbox checkout is detached: name the local branch with --as`)
  await assertBranchName(repo, target, env)
  if (!args.as && (await localBranchExists(repo, target, env))) {
    throw new UserError(
      `local branch ${target} already exists: pass --as <branch> to choose where to copy`,
    )
  }
  const ref = branch ? `refs/heads/${branch}` : 'HEAD'
  const bundle = await downloadBundle(session, checkout, home, ref)
  await fetchBundle(repo, bundle, `${args.as ? '+' : ''}${ref}:refs/heads/${target}`, env)
  const head = await git(repo, ['rev-parse', '--short', `refs/heads/${target}`], env)
  context.stderr.write(
    `copied sandbox ${name} to local branch ${target} (${head}); push it with: git push -u origin ${target}\n`,
  )
}

export const pullCommand: Command = { readsPayload: false, run: runPull }
