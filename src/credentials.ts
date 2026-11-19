import { UserError } from './errors.ts'

export interface VercelCredentials {
  token: string
  teamId: string
  projectId: string
}

export const VARIABLES = {
  token: 'VERCEL_TOKEN',
  teamId: 'VERCEL_TEAM_ID',
  projectId: 'VERCEL_PROJECT_ID',
} as const satisfies Record<keyof VercelCredentials, string>

// Printable ASCII with no space: all an HTTP header or a Vercel ID can hold. Anything else (a
// pasted zero-width character, a smart quote) would only fail later as an opaque header error.
function isUnsafe(value: string): boolean {
  return !/^[\x21-\x7e]+$/.test(value)
}

// The one place a variable is read, so whoever redacts it shares the trim rule.
export function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim()
}

// Reads the credentials from the environment (exported in the shell profile) and checks their
// shape, so a missing or garbled value fails here with a clear message instead of as an opaque
// API error. It never reads or writes a file, and no message repeats a value.
export function resolveCredentials(env: NodeJS.ProcessEnv): VercelCredentials {
  const found: Partial<VercelCredentials> = {}
  const problems: string[] = []
  for (const [field, name] of Object.entries(VARIABLES) as [keyof VercelCredentials, string][]) {
    const value = readEnv(env, name)
    if (!value) problems.push(`${name} is not set`)
    else if (isUnsafe(value)) problems.push(`${name} is not valid (printable ASCII, no spaces)`)
    else found[field] = value
  }
  if (problems.length > 0) {
    throw new UserError(
      `Vercel credentials: ${problems.join('; ')}. Export them in your shell profile ` +
        `(a token from vercel.com/account/tokens, plus the team and project IDs).`,
    )
  }
  return found as VercelCredentials
}
