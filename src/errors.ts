export class UserError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'UserError'
  }
}

export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
