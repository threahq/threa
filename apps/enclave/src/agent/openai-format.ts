import { z } from "zod"
import type { ModelMessage, Tool, ToolResultPart } from "ai"

/**
 * Pure conversions between the Vercel AI SDK's `ModelMessage`/`Tool` shapes
 * (what `AgentRuntime` speaks) and the OpenAI chat-completions wire format (what
 * OpenRouter expects). Kept dependency-free and side-effect-free so the enclave
 * can unit-test the round trip without a network or a running model.
 *
 * The enclave deliberately re-derives this mapping rather than importing the AI
 * SDK's OpenRouter provider: that provider drags in telemetry hooks and a wider
 * dependency tree, and the whole point of the enclave is a minimal surface with
 * a single egress host. This file is small enough to audit in full.
 */

export interface OpenAiToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

/**
 * OpenAI/OpenRouter multimodal content parts. OpenRouter passes `image_url`
 * (data URL) and `file` (base64 `file_data`) parts through to vision/PDF-capable
 * models like Claude — that's how the enclave feeds decrypted attachments to the
 * model without ever giving the server the plaintext.
 */
export type OpenAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } }

export interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string | OpenAiContentPart[] | null
  tool_calls?: OpenAiToolCall[]
  tool_call_id?: string
}

export interface OpenAiTool {
  type: "function"
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** Flatten a `ModelMessage` content (string or content-parts) to plain text. */
function contentToText(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
}

/** AI-SDK user content part shapes the enclave produces for attachment turns. */
type UserModelPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string }
  | { type: "file"; data: string; mediaType: string; filename: string }

/**
 * Convert a user `ModelMessage` content to OpenAI form. A plain string (or a
 * parts array with only text) stays a string — byte-identical to the old
 * text-only path. Once an image/file part is present, emit the multimodal parts
 * array OpenRouter forwards to the model.
 */
function toUserContent(content: ModelMessage["content"]): string | OpenAiContentPart[] {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: OpenAiContentPart[] = []
  let hasMedia = false
  for (const raw of content) {
    const part = raw as UserModelPart
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text })
    } else if (part.type === "image" && typeof part.image === "string") {
      parts.push({ type: "image_url", image_url: { url: part.image } })
      hasMedia = true
    } else if (part.type === "file" && typeof part.data === "string") {
      parts.push({
        type: "file",
        file: { filename: part.filename, file_data: `data:${part.mediaType};base64,${part.data}` },
      })
      hasMedia = true
    }
  }
  if (!hasMedia) return parts.map((p) => (p.type === "text" ? p.text : "")).join("")
  return parts
}

/** Split an assistant message into its text and any tool-call parts. */
function splitAssistant(content: ModelMessage["content"]): { text: string; toolCalls: OpenAiToolCall[] } {
  if (typeof content === "string") return { text: content, toolCalls: [] }
  if (!Array.isArray(content)) return { text: "", toolCalls: [] }

  let text = ""
  const toolCalls: OpenAiToolCall[] = []
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") {
      text += part.text
    } else if (part.type === "tool-call") {
      const tc = part as { toolCallId: string; toolName: string; input: unknown }
      toolCalls.push({
        id: tc.toolCallId,
        type: "function",
        function: { name: tc.toolName, arguments: JSON.stringify(tc.input ?? {}) },
      })
    }
  }
  return { text, toolCalls }
}

/** Read the text value out of a runtime tool-result part. */
function toolResultText(part: ToolResultPart): string {
  const output = part.output as { type?: string; value?: unknown } | undefined
  if (output && output.type === "text" && typeof output.value === "string") return output.value
  return JSON.stringify(output?.value ?? output ?? "")
}

/**
 * Convert the system prompt + the loop's running conversation into the OpenAI
 * `messages` array. A `tool`-role `ModelMessage` carries one or more
 * `ToolResultPart`s; OpenAI wants one `tool` message per result, keyed by
 * `tool_call_id`, so those fan out.
 */
export function toOpenAiMessages(system: string | undefined, messages: ModelMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = []
  if (system) out.push({ role: "system", content: system })

  for (const m of messages) {
    switch (m.role) {
      case "system":
        out.push({ role: "system", content: contentToText(m.content) })
        break
      case "user":
        out.push({ role: "user", content: toUserContent(m.content) })
        break
      case "assistant": {
        const { text, toolCalls } = splitAssistant(m.content)
        out.push({
          role: "assistant",
          content: text.length > 0 ? text : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        })
        break
      }
      case "tool": {
        const parts = (Array.isArray(m.content) ? m.content : []) as ToolResultPart[]
        for (const part of parts) {
          out.push({ role: "tool", tool_call_id: part.toolCallId, content: toolResultText(part) })
        }
        break
      }
    }
  }
  return out
}

/** Convert the runtime's tool definitions (zod input schemas) to OpenAI tools. */
export function toOpenAiTools(tools: Record<string, Tool<any, any>> | undefined): OpenAiTool[] | undefined {
  if (!tools) return undefined
  const list = Object.entries(tools).map(([name, def]) => ({
    type: "function" as const,
    function: {
      name,
      description: def.description ?? "",
      parameters: toJsonSchema((def as { inputSchema?: unknown }).inputSchema),
    },
  }))
  return list.length > 0 ? list : undefined
}

/**
 * Best-effort zod → JSON Schema for a tool's input schema. Falls back to an
 * open object when the schema isn't a zod type we can convert, so an exotic tool
 * still reaches the model (with a permissive schema) rather than failing the turn.
 */
function toJsonSchema(schema: unknown): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema as z.ZodType) as Record<string, unknown>
  } catch {
    return { type: "object", properties: {}, additionalProperties: true }
  }
}

/**
 * Rebuild the assistant `ModelMessage` the loop pushes onto the conversation.
 * Text-only stays a string; with tool calls it becomes the parts array the loop
 * (and a subsequent `toOpenAiMessages`) round-trips back to OpenAI faithfully.
 */
type AssistantPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }

export function buildAssistantMessage(
  text: string,
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>
): ModelMessage {
  if (toolCalls.length === 0) return { role: "assistant", content: text }
  const parts: AssistantPart[] = []
  if (text.length > 0) parts.push({ type: "text", text })
  for (const tc of toolCalls) {
    parts.push({ type: "tool-call", toolCallId: tc.toolCallId, toolName: tc.toolName, input: tc.input })
  }
  // The AI SDK's AssistantContent permits text + tool-call parts; our literals
  // match those shapes structurally (the SDK adds optional fields we omit), but
  // the role↔content discriminated union needs the whole message asserted.
  return { role: "assistant", content: parts } as unknown as ModelMessage
}
