import { UserError } from './errors.ts'

export interface LifecyclePayload {
  sandbox: string
}

interface RawPayload {
  recipeResult?: {
    userData?: { resourceId?: unknown }
  }
}

export const SANDBOX_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

// What Orca pipes to suspend, resume and destroy: the result `create` printed, wrapped with the
// phase. The sandbox is userData.resourceId.
export function parseLifecyclePayload(raw: string): LifecyclePayload {
  if (!raw.trim()) throw new UserError('Orca sent no lifecycle payload on stdin')
  let parsed: RawPayload
  try {
    parsed = JSON.parse(raw) as RawPayload
  } catch {
    throw new UserError("Orca's lifecycle payload is not JSON")
  }
  const result = parsed?.recipeResult
  const sandbox = text(result?.userData?.resourceId)
  if (!sandbox || !SANDBOX_NAME.test(sandbox)) {
    throw new UserError('the lifecycle payload names no sandbox')
  }
  return { sandbox }
}
