import { HttpError } from "@threahq/backend-common"

export function invocationClaimNotFound(): HttpError {
  return new HttpError("Invocation claim not found", { status: 404, code: "NOT_FOUND" })
}

export function invocationInputStale(): HttpError {
  return new HttpError("Invocation input is stale", { status: 409, code: "INVOCATION_INPUT_STALE" })
}
