import { tool } from "ai"
import { z } from "zod"
import type { SourceItem } from "@threa/types"

const SendMessageSchema = z.object({
  content: z.string().describe("The message content to send"),
})

export type SendMessageInput = z.infer<typeof SendMessageSchema>

/**
 * Extended input for internal use (not exposed to the LLM tool schema).
 * The sources are added programmatically by the agent loop, not by the LLM.
 */
export interface SendMessageInputWithSources extends SendMessageInput {
  sources?: SourceItem[]
}

export interface SendMessageResult {
  messageId: string
  content: string
}

/**
 * Creates a send_message tool definition WITHOUT an execute handler.
 * The agent loop intercepts send_message calls and stages them (prep-then-send pattern).
 */
export function createSendMessageTool() {
  return tool({
    description: "Send a message to the conversation. You can call this multiple times to send multiple messages.",
    inputSchema: SendMessageSchema,
  })
}
