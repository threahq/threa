import { HttpError } from "@threahq/backend-common"

export { HttpError, isUniqueViolation } from "@threahq/backend-common"

/** Error codes are logged, messages are not: `WebPushError` and pg errors carry endpoints, bodies and row values. */
export function safeErrorCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null
  const code = (err as { code?: unknown }).code
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : null
}

export class DuplicateSlugError extends HttpError {
  constructor(slug: string) {
    super(`Channel with slug "${slug}" already exists`, {
      status: 409,
      code: "DUPLICATE_SLUG",
    })
    this.name = "DuplicateSlugError"
  }
}

export class StreamNotFoundError extends HttpError {
  constructor() {
    super("Stream not found", {
      status: 404,
      code: "STREAM_NOT_FOUND",
    })
    this.name = "StreamNotFoundError"
  }
}

export class MessageNotFoundError extends HttpError {
  constructor() {
    super("Message not found", {
      status: 404,
      code: "MESSAGE_NOT_FOUND",
    })
    this.name = "MessageNotFoundError"
  }
}
