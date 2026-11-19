export class UserError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'UserError'
  }
}

// Includes the cause one level down: undici reports "fetch failed" and keeps the reason there.
export function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message
}
