import { HttpError } from "@threa/backend-common"
import { z } from "zod"

/**
 * Parse `value` against `schema`, returning the typed data on success. On
 * failure, throws an `HttpError` (status 400, `VALIDATION_ERROR`) carrying the
 * flattened field errors as `details`. Express 5 surfaces the throw to the
 * shared error middleware, which formats `{ error, code, details }` (INV-32) —
 * replacing the hand-rolled `safeParse` + `res.status(400).json(...)` blocks.
 */
export function validateRequest<Schema extends z.ZodType>(schema: Schema, value: unknown): z.infer<Schema> {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new HttpError("Validation failed", {
      status: 400,
      code: "VALIDATION_ERROR",
      details: z.flattenError(result.error).fieldErrors,
    })
  }
  return result.data
}
