import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { UserError } from './errors.ts'

const run = promisify(execFile)

const SAFE_REPO_NAME = /^[\w][\w.-]*$/
const SAFE_BRANCH = /^[\w][\w./-]*$/
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/

// The temporary ref the bundle carries the commit under; it is removed from the local repo again.
export const BUNDLE_REF = 'refs/vercel-orca/checkout'

// What Orca picked for the workspace, and what the sandbox checkout needs from the local repo.
export interface CheckoutSource {
  repoName: string
  // Absent for a detached commit.
  branch?: string
  commit: string
  // The exact commit and its history, as the bytes of a Git bundle.
  bundle: Buffer
  // An HTTPS URL without credentials; absent when the repo has no remote.
  originUrl?: string
  gitName: string
  gitEmail: string
}

async function git(repoPath: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
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

function branchOf(env: NodeJS.ProcessEnv): string | undefined {
  const branch = (env.ORCA_REPO_BRANCH ?? '').trim().replace(/^refs\/heads\//, '')
  if (!branch) return undefined
  if (!SAFE_BRANCH.test(branch)) throw new UserError(`unsupported branch name: ${branch}`)
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
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'vercel-orca-bundle-'))
  const file = join(dir, 'checkout.bundle')
  try {
    // A bundle needs a ref; this one lives only while the bundle is written.
    await git(repoPath, ['update-ref', BUNDLE_REF, commit], env)
    try {
      await git(repoPath, ['bundle', 'create', '--quiet', file, BUNDLE_REF], env)
    } finally {
      await git(repoPath, ['update-ref', '-d', BUNDLE_REF], env)
    }
    return await readFile(file)
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
  const branch = branchOf(env)
  const commit = await commitOf(repoPath, env)
  const remote = (env.ORCA_REPO_URL ?? '').trim()
  return {
    repoName,
    branch,
    commit,
    bundle: await createBundle(repoPath, commit, env),
    originUrl: remote ? httpsOrigin(remote) : undefined,
    ...(await identityOf(repoPath, env)),
  }
}
