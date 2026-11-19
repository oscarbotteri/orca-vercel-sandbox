import { UserError } from './errors.ts'

export interface VercelCredentials {
  token: string
  teamId: string
  projectId: string
}

const VARIABLES = {
  token: 'VERCEL_TOKEN',
  teamId: 'VERCEL_TEAM_ID',
  projectId: 'VERCEL_PROJECT_ID',
} as const satisfies Record<keyof VercelCredentials, string>

// Anything an HTTP header or an ID cannot hold: whitespace or control characters.
function isUnsafe(value: string): boolean {
  return /\s/.test(value) || [...value].some((char) => char <= '\u001f' || char === '\u007f')
}

// Reads the credentials from the environment (exported in the shell profile) and checks their
// shape, so a missing or garbled value fails here with a clear message instead of as an opaque
// API error. It never reads or writes a file, and no message repeats a value.
export function resolveCredentials(env: NodeJS.ProcessEnv): VercelCredentials {
  const found: Partial<VercelCredentials> = {}
  const problems: string[] = []
  for (const [field, name] of Object.entries(VARIABLES) as [keyof VercelCredentials, string][]) {
    const value = env[name]?.trim()
    if (!value) problems.push(`${name} is not set`)
    else if (isUnsafe(value))
      problems.push(`${name} is not valid (no spaces or control characters)`)
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
