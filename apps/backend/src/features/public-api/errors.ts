import { HttpError } from "@threa/backend-common"

export function invocationClaimNotFound(): HttpError {
  return new HttpError("Invocation claim not found", { status: 404, code: "NOT_FOUND" })
}
