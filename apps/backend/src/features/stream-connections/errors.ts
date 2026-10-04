import { StreamConnectionErrorCodes } from "@threahq/types"
import { HttpError } from "../../lib/errors"

/** One answer for every refusal, so a caller can't tell a missing connection from one it may not reach. */
export function connectionNotFound(): HttpError {
  return new HttpError("Connection not found", { status: 404, code: StreamConnectionErrorCodes.NOT_FOUND })
}

/** The partner may not write that: the stream, message or author isn't one the connection reaches. */
export function writeRefused(reason: string): HttpError {
  return new HttpError(reason, { status: 403, code: StreamConnectionErrorCodes.WRITE_REFUSED })
}

/** The host's region didn't confirm a partner's write; a retry is safe, since the host dedupes a send by its client message id. */
export function hostUnreachable(reason: string): HttpError {
  return new HttpError(reason, { status: 503, code: StreamConnectionErrorCodes.HOST_UNREACHABLE })
}
