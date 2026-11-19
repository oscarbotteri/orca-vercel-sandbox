import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dirs: string[] = []

export function cleanupGitDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

export function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
}

export interface LocalRepo {
  path: string
  name: string
  // The commit on `main` after the first commit, and the latest one.
  first: string
  head: string
}

// A repository on `main` with two commits, named `name` as Orca's repo path would be.
export function makeRepo(name = 'project', identity = true): LocalRepo {
  const path = join(tempDir('vercel-orca-repo-'), name)
  mkdirSync(path)
  git(path, 'init', '--quiet', '-b', 'main')
  if (identity) {
    git(path, 'config', 'user.name', 'Ada Lovelace')
    git(path, 'config', 'user.email', 'ada@example.com')
  }
  function commit(file: string): string {
    writeFileSync(join(path, file), `${file}\n`)
    git(path, 'add', file)
    git(
      path,
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.com',
      'commit',
      '--quiet',
      '-m',
      file,
    )
    return git(path, 'rev-parse', 'HEAD')
  }
  const first = commit('one.txt')
  const head = commit('two.txt')
  return { path, name, first, head }
}
