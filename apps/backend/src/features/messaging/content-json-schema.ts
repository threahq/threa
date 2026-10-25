import { z } from "zod"
import type { JSONContent } from "@threahq/types"
import { InvalidContentError, normalizeContentJson } from "@threahq/prosemirror/schema"

export const contentJsonSchema = z
  .object({
    type: z.literal("doc"),
    content: z.array(z.any()),
  })
  .transform((doc, ctx): JSONContent => {
    try {
      return normalizeContentJson(doc)
    } catch (error) {
      if (!(error instanceof InvalidContentError)) throw error
      // `continue` keeps the issue non-aborting, so the union reports this
      // variant's message instead of a bare invalid_union.
      ctx.addIssue({ code: "custom", message: error.message, continue: true })
      return z.NEVER
    }
  })
