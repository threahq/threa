import { BOT_INPUT_UPDATE_MODES } from "@threahq/types"
import { z } from "zod"

export const botRuntimeManifestSchema = z.object({
  output: z.object({
    reply: z.boolean().optional().default(true),
    trace: z.boolean().optional().default(true),
    sources: z.boolean().optional().default(false),
  }),
  input: z.object({ updates: z.enum(BOT_INPUT_UPDATE_MODES) }).optional(),
})
