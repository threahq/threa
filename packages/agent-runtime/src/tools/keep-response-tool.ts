import { tool } from "ai"
import { z } from "zod"

const KeepResponseSchema = z.object({
  reason: z.string().min(1).describe("Why the existing response is still correct and should remain unchanged"),
})

/**
 * Creates a keep_response tool definition WITHOUT an execute handler.
 * The runtime intercepts this call and treats it as an explicit no-change decision.
 */
export function createKeepResponseTool() {
  return tool({
    description:
      "Keep the previously sent response unchanged. Use this instead of send_message when no response updates are needed.",
    inputSchema: KeepResponseSchema,
  })
}
