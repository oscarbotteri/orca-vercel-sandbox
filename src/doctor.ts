import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import type { Command, CommandContext } from './commands.ts'
import { resolveCredentials, type VercelCredentials } from './credentials.ts'
import { reasonOf, UserError } from './errors.ts'
import { type AdapterHome, resolveHome } from './home.ts'
import { wrapperPath } from './install.ts'
import { findMissingPrerequisites } from './prerequisites.ts'
import { describeSandboxes, orphansOf } from './sandbox-report.ts'
import {
  includeLine,
  listSandboxHosts,
  userConfigHasInclude,
  userSshConfigPath,
} from './ssh-config.ts'
import { keyPath } from './ssh-keys.ts'

const API = 'https://api.vercel.com'
const HOBBY_MINUTES = 45

interface Findings {
  problems: string[]
  warnings: string[]
}

function sshProblems(env: NodeJS.ProcessEnv, home: AdapterHome): string[] {
  const problems: string[] = []
  const line = includeLine(home.sshConfig)
  const userConfig = userSshConfigPath(env, homedir())
  if (!userConfigHasInclude(userConfig, line)) {
    problems.push(`${userConfig} does not hold "${line}"; run "vercel-orca setup"`)
  }
  for (const name of listSandboxHosts(home.sshConfig)) {
    const key = keyPath(home, name)
    if (!existsSync(key)) problems.push(`${name} has an SSH block but its key is missing`)
    else if ((statSync(key).mode & 0o077) !== 0) problems.push(`the key of ${name} is not 600`)
  }
  return problems
}

// The Vercel API tells the plan; the sandbox SDK does not.
async function planWarning(
  credentials: VercelCredentials,
  { network }: CommandContext,
): Promise<string | undefined> {
  try {
    const response = await network.fetch(`${API}/v2/teams/${credentials.teamId}`, {
      headers: { authorization: `Bearer ${credentials.token}` },
    })
    if (!response.ok) return `could not read the Vercel plan (HTTP ${response.status})`
    const body = (await response.json()) as { billing?: { plan?: string } }
    if (body.billing?.plan === 'hobby') {
      return `the team is on the Hobby plan: sessions stop after ${HOBBY_MINUTES} minutes (Pro allows 24 hours)`
    }
  } catch (error) {
    return `could not read the Vercel plan: ${reasonOf(error)}`
  }
  return undefined
}

async function remoteFindings(
  context: CommandContext,
  home: AdapterHome,
  findings: Findings,
): Promise<void> {
  const warning = await planWarning(resolveCredentials(context.env), context)
  if (warning) findings.warnings.push(warning)
  try {
    const rows = describeSandboxes(home, await context.sandboxes().list())
    for (const { name, state } of orphansOf(rows)) {
      findings.warnings.push(`orphan sandbox ${name} (${state}): no workspace uses it`)
    }
  } catch (error) {
    findings.problems.push(reasonOf(error))
  }
}

// Reads and reports; it creates, changes and deletes nothing, on Vercel or here.
export const doctorCommand: Command = {
  readsPayload: false,
  async run(context) {
    const home = resolveHome(context.env)
    const missing = findMissingPrerequisites(context.env)
    const findings: Findings = { problems: [...missing], warnings: [] }
    if (!existsSync(wrapperPath(home))) {
      findings.problems.push('the adapter is not installed; run "vercel-orca setup"')
    }
    findings.problems.push(...sshProblems(context.env, home))
    if (!missing.some((item) => item.startsWith('Vercel credentials'))) {
      await remoteFindings(context, home, findings)
    }
    const lines = [
      ...findings.problems.map((text) => `problem: ${text}`),
      ...findings.warnings.map((text) => `warning: ${text}`),
    ]
    context.stderr.write(`${lines.length === 0 ? 'ok: nothing to fix' : lines.join('\n')}\n`)
    if (findings.problems.length > 0) {
      throw new UserError(`doctor found ${findings.problems.length} problem(s)`)
    }
  },
}
