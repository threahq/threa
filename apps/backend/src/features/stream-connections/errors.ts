import { StreamConnectionErrorCodes } from "@threahq/types"
import { HttpError } from "../../lib/errors"

/** One answer for every refusal, so a caller can't tell a missing connection from one it may not reach. */
export function connectionNotFound(): HttpError {
  return new HttpError("Connection not found", { status: 404, code: StreamConnectionErrorCodes.NOT_FOUND })
}
