import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { UserError } from './errors.ts'

const run = promisify(execFile)

const SAFE_REPO_NAME = /^[\w][\w.-]*$/
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/

// What Orca picked for the workspace, and what the sandbox checkout needs from the local repo.
export interface CheckoutSource {
  repoName: string
  repoPath: string
  // Absent for a detached commit.
  branch?: string
  commit: string
  // The exact commit and its history, as the bytes of a Git bundle, and the ref it carries it under.
  bundle: Buffer
  bundleRef: string
  // An HTTPS URL without credentials; absent when the repo has no remote.
  originUrl?: string
  gitName: string
  gitEmail: string
}

export async function git(
  repoPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    return (await run('git', ['-C', repoPath, ...args], { env })).stdout.trim()
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr).trim() : ''
    throw new UserError(`git ${args[0]} failed in ${repoPath}${stderr ? `: ${stderr}` : ''}`, {
      cause: error,
    })
  }
}

// Orca remotes are often SSH; the sandbox holds no key, so it gets the HTTPS form, without any
// user or password the URL carried.
export function httpsOrigin(remote: string): string | undefined {
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(remote)
  const candidate = scp ? `https://${scp[1]}/${scp[2]}` : remote
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return undefined
  }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return undefined
  return `https://${url.hostname}${url.port && url.protocol === 'https:' ? `:${url.port}` : ''}${url.pathname}`
}

// Git decides what a branch name is; a leading dash is refused here since the name reaches a
// command line (quoted, but still read as an option).
async function branchOf(repoPath: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const branch = (env.ORCA_REPO_BRANCH ?? '').trim().replace(/^refs\/heads\//, '')
  if (!branch) return undefined
  const valid =
    !branch.startsWith('-') &&
    (await git(repoPath, ['check-ref-format', '--branch', branch], env).then(
      () => true,
      () => false,
    ))
  if (!valid) throw new UserError(`unsupported branch name: ${branch}`)
  return branch
}

async function commitOf(repoPath: string, env: NodeJS.ProcessEnv): Promise<string> {
  const given = (env.ORCA_REPO_REF_HEAD ?? '').trim()
  if (given) {
    if (!COMMIT.test(given)) throw new UserError(`Orca sent an invalid commit: ${given}`)
    return given
  }
  const ref = (env.ORCA_REPO_REF ?? '').trim() || 'HEAD'
  return git(repoPath, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], env)
}

async function createBundle(
  repoPath: string,
  commit: string,
  env: NodeJS.ProcessEnv,
): Promise<{ bundle: Buffer; ref: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'vercel-orca-bundle-'))
  const file = join(dir, 'checkout.bundle')
  // A bundle needs a ref; this one is unique to the run, so concurrent creates cannot clash, and
  // lives only while the bundle is written.
  const ref = `refs/vercel-orca/checkout-${randomUUID()}`
  try {
    await git(repoPath, ['update-ref', ref, commit], env)
    try {
      await git(repoPath, ['bundle', 'create', '--quiet', file, ref], env)
    } finally {
      await git(repoPath, ['update-ref', '-d', ref], env)
    }
    return { bundle: await readFile(file), ref }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function identityOf(
  repoPath: string,
  env: NodeJS.ProcessEnv,
): Promise<{ gitName: string; gitEmail: string }> {
  function read(key: string): Promise<string> {
    return git(repoPath, ['config', '--get', key], env).catch(() => '')
  }
  const [gitName, gitEmail] = await Promise.all([read('user.name'), read('user.email')])
  if (!gitName || !gitEmail) {
    throw new UserError(`set user.name and user.email in ${repoPath}: the sandbox commits as them`)
  }
  return { gitName, gitEmail }
}

// Runs before the sandbox exists, so a repo that cannot be bundled costs nothing.
export async function prepareCheckout(env: NodeJS.ProcessEnv): Promise<CheckoutSource> {
  const repoPath = (env.ORCA_REPO_PATH ?? '').trim()
  if (!repoPath) throw new UserError('Orca did not say which repository to check out')
  const repoName = basename(repoPath)
  if (!SAFE_REPO_NAME.test(repoName))
    throw new UserError(`unsupported repository name: ${repoName}`)
  const branch = await branchOf(repoPath, env)
  const commit = await commitOf(repoPath, env)
  // The cheap checks go first: the bundle is the expensive step.
  const identity = await identityOf(repoPath, env)
  const { bundle, ref } = await createBundle(repoPath, commit, env)
  const remote = (env.ORCA_REPO_URL ?? '').trim()
  return {
    repoName,
    repoPath,
    branch,
    commit,
    bundle,
    bundleRef: ref,
    originUrl: remote ? httpsOrigin(remote) : undefined,
    ...identity,
  }
}
