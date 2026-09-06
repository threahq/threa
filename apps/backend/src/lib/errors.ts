import { HttpError } from "@threahq/backend-common"

export { HttpError, isUniqueViolation } from "@threahq/backend-common"

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
