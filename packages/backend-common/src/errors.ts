interface HttpErrorOptions {
  status: number
  code?: string
  cause?: Error
  details?: unknown
}

export class HttpError extends Error {
  readonly status: number
  readonly code?: string
  readonly details?: unknown

  constructor(message: string, { status, code, cause, details }: HttpErrorOptions) {
    super(message, { cause })
    this.status = status
    this.code = code
    this.details = details
    this.name = "HttpError"
  }
}

/** Check if a PostgreSQL error is a unique constraint violation (code 23505). */
export function isUniqueViolation(error: unknown, constraintName?: string): boolean {
  if (!error || typeof error !== "object") return false
  const pgError = error as { code?: string; constraint?: string }
  if (pgError.code !== "23505") return false
  if (constraintName && pgError.constraint !== constraintName) return false
  return true
}
