import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { git } from './git-bundle.ts'
import { shellQuote } from './install.ts'
import type { SandboxSession } from './sandbox-session.ts'
import type { SandboxState } from './sandbox-state.ts'

// Where the sandbox holds a ref for each thing to save, and the local branches they become.
const SANDBOX_REFS = 'refs/vercel-orca-save'
function localPrefix(name: string): string {
  return `refs/heads/vercel-orca/saved/${name}`
}

interface Worktree {
  path: string
  head: string
  detached: boolean
}

// The first entry is the main checkout.
function parseWorktrees(porcelain: string): Worktree[] {
  return porcelain
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const lines = block.split('\n')
      function field(key: string): string {
        return lines.find((line) => line.startsWith(`${key} `))?.slice(key.length + 1) ?? ''
      }
      return { path: field('worktree'), head: field('HEAD'), detached: lines.includes('detached') }
    })
}

// Finds unpushed work in the sandbox and keeps each piece under its own ref, there.
class Collector {
  readonly refs: string[] = []

  private readonly session: SandboxSession
  private readonly state: SandboxState

  constructor(session: SandboxSession, state: SandboxState) {
    this.session = session
    this.state = state
  }

  private git(path: string, args: string): Promise<string> {
    return this.session.exec(`git -C ${shellQuote(path)} ${args}`).then((out) => out.trim())
  }

  private repo(args: string): Promise<string> {
    return this.git(this.state.projectRoot, args)
  }

  async clearStale(): Promise<void> {
    const stale = await this.repo(`for-each-ref --format='%(refname)' ${SANDBOX_REFS}`)
    for (const ref of stale.split('\n').filter(Boolean)) await this.repo(`update-ref -d ${ref}`)
  }

  private async keep(name: string, commit: string): Promise<void> {
    const ref = `${SANDBOX_REFS}/${name}`
    await this.repo(`update-ref ${ref} ${commit}`)
    this.refs.push(ref)
  }

  private async hasNewCommits(path: string, commit: string): Promise<boolean> {
    return (await this.git(path, `rev-list -n 1 ${commit} --not ${this.state.baseCommit}`)) !== ''
  }

  async branches(): Promise<void> {
    const listing = await this.repo(
      `for-each-ref --no-merged ${this.state.baseCommit} --format='%(objectname) %(refname:lstrip=2)' refs/heads`,
    )
    for (const line of listing.split('\n').filter(Boolean)) {
      const [commit, branch] = [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]
      await this.keep(`branches/${branch}`, commit)
    }
  }

  async stash(): Promise<void> {
    const commit = await this.repo("for-each-ref --format='%(objectname)' refs/stash")
    if (commit) await this.keep('stash', commit)
  }

  // A commit of everything in the work tree, untracked files included, on top of HEAD. It uses a
  // throwaway index, so the sandbox's own index and work tree are left as they are.
  private async uncommitted(worktree: Worktree): Promise<string | undefined> {
    const index = shellQuote(`${this.state.projectRoot}/.git/vercel-orca-save.index`)
    const path = shellQuote(worktree.path)
    const tree = (
      await this.session.exec(
        `GIT_INDEX_FILE=${index}; export GIT_INDEX_FILE; ` +
          `git -C ${path} read-tree HEAD && git -C ${path} add -A && git -C ${path} write-tree; ` +
          `status=$?; rm -f ${index}; exit $status`,
      )
    ).trim()
    if (tree === (await this.git(worktree.path, "rev-parse 'HEAD^{tree}'"))) return undefined
    return this.git(
      worktree.path,
      `commit-tree ${tree} -p HEAD -m 'vercel-orca: uncommitted changes'`,
    )
  }

  async worktrees(): Promise<void> {
    const found = parseWorktrees(await this.repo('worktree list --porcelain'))
    const used = new Set<string>()
    for (const [index, worktree] of found.entries()) {
      let prefix = ''
      if (index > 0) {
        let label = basename(worktree.path)
        for (let n = 2; used.has(label); n++) label = `${basename(worktree.path)}-${n}`
        used.add(label)
        prefix = `worktrees/${label}/`
      }
      if (worktree.detached && (await this.hasNewCommits(worktree.path, worktree.head))) {
        await this.keep(`${prefix}detached`, worktree.head)
      }
      const dirty = await this.uncommitted(worktree)
      if (dirty) await this.keep(`${prefix}uncommitted`, dirty)
    }
  }
}

// Copies everything unpushed from the sandbox into branches under vercel-orca/saved/<name>/ of
// the local repository. Nothing here changes the sandbox's branches, stash or work trees. Any
// failure throws, so the caller keeps the sandbox.
export async function saveUnpushedWork(
  session: SandboxSession,
  state: SandboxState,
  name: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const collector = new Collector(session, state)
  await collector.clearStale()
  await collector.branches()
  await collector.stash()
  await collector.worktrees()
  if (collector.refs.length === 0) return []

  const bundle = shellQuote(`${state.projectRoot}/.git/vercel-orca-save.bundle`)
  const repo = shellQuote(state.projectRoot)
  let encoded: string
  try {
    await session.exec(
      `git -C ${repo} bundle create --quiet ${bundle} ${collector.refs.join(' ')} ^${state.baseCommit}`,
    )
    encoded = await session.exec(`base64 < ${bundle}`)
  } finally {
    await session.exec(`rm -f ${bundle}`).catch(() => '')
  }
  const dir = await mkdtemp(join(tmpdir(), 'vercel-orca-saved-'))
  try {
    const file = join(dir, 'saved.bundle')
    await writeFile(file, Buffer.from(encoded, 'base64'))
    // Forced, so a retry after a failed destroy overwrites what the first try saved.
    await git(
      state.repoPath,
      ['fetch', '--quiet', file, `+${SANDBOX_REFS}/*:${localPrefix(name)}/*`],
      env,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  return collector.refs.map((ref) => ref.slice(SANDBOX_REFS.length + 1))
}
