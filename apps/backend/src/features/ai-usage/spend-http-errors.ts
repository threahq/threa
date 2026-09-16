import type { ErrorRequestHandler } from "express"
import { SpendingDeniedError } from "@threahq/agent-runtime"
import { HttpError } from "../../lib/errors"

export const spendingErrorHandler: ErrorRequestHandler = (error, _req, _res, next) => {
  if (error instanceof SpendingDeniedError) {
    next(
      new HttpError("AI admission denied", {
        status: 403,
        code: "AI_SPENDING_DENIED",
        details: { reason: error.code },
      })
    )
    return
  }
  next(error)
}
