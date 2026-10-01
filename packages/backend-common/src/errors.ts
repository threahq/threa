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

/** Error codes are logged, messages are not: `WebPushError` and pg errors carry endpoints, bodies and row values. */
export function safeErrorCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null
  const code = (err as { code?: unknown }).code
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : null
}
