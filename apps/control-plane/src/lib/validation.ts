import type { z } from "zod/v4"
import { HttpError } from "@threahq/backend-common"

export function parseRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new HttpError("Invalid request", { status: 400, code: "VALIDATION_ERROR" })
  return parsed.data
}
