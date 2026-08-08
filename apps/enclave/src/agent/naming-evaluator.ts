import { z } from "zod"
import { ENCLAVE_NAMING_CHECKPOINTS, type EnclaveNamingInstruction } from "@threa/types"
import type { RawChatFn } from "../llm"

const MAX_TITLE_CHARS = 60

export function sanitizeTitle(raw: string | null | undefined): string | null {
  if (!raw) return null
  const firstLine = raw
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) return null
  const unquoted = firstLine
    .replace(/^["'“”‘’]+/, "")
    .replace(/["'“”‘’]+$/, "")
    .replace(/\.+$/, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!unquoted) return null
  return unquoted.length > MAX_TITLE_CHARS ? unquoted.slice(0, MAX_TITLE_CHARS).trim() : unquoted
}

const responseSchema = z
  .object({
    action: z.enum(["defer", "keep", "rename"]),
    title: z.string(),
    confidence: z.number().min(0).max(1),
  })
  .strict()

export type EnclaveNamingEvaluation =
  | { action: "defer"; confidence: number }
  | { action: "keep"; confidence: number }
  | { action: "rename"; confidence: number; title: string }

export function advanceNamingInstruction(
  instruction: EnclaveNamingInstruction,
  observedMessageCount: number
): EnclaveNamingInstruction {
  const checkpoint =
    [...ENCLAVE_NAMING_CHECKPOINTS].reverse().find((candidate) => candidate <= observedMessageCount) ?? 1
  return {
    ...instruction,
    checkpoint,
    messageCount: observedMessageCount,
    forced: instruction.forced || checkpoint >= 3,
  }
}

const SYSTEM = `Evaluate whether a conversation title should be deferred, kept, or renamed.
- defer only at a non-forced checkpoint 1 when no useful subject is identifiable.
- keep when the current title remains materially accurate and specific enough.
- rename when absent, inaccurate, or materially misleading; return a concise 2-5 word title.
Preserve a good title rather than rewriting for style. Use the participants' dominant language and preserve names and technical terms. A forced evaluation must never defer. Return strict JSON.`

export async function evaluateNaming(params: {
  rawChat: RawChatFn
  model: string
  instruction: EnclaveNamingInstruction
  currentTitle: string | null
  context: string
  signal?: AbortSignal
}): Promise<EnclaveNamingEvaluation | null> {
  try {
    const result = await params.rawChat({
      model: params.model,
      temperature: 0.3,
      maxTokens: 80,
      signal: params.signal,
      responseFormat: {
        type: "json_schema",
        json_schema: {
          name: "dynamic_naming_decision",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["action", "title", "confidence"],
            properties: {
              action: { type: "string", enum: ["defer", "keep", "rename"] },
              title: { type: "string" },
              confidence: { type: "number", minimum: 0, maximum: 1 },
            },
          },
        },
      },
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `${JSON.stringify({
            checkpoint: params.instruction.checkpoint,
            forced: params.instruction.forced,
            currentTitle: params.currentTitle,
            messageCount: params.instruction.messageCount,
          })}\n\n${params.context}`,
        },
      ],
    })
    if (!result.message.content) return null
    const parsed = responseSchema.parse(JSON.parse(result.message.content))
    if (params.instruction.forced && parsed.action === "defer") return null
    if (params.currentTitle === null && parsed.action === "keep") return null
    if (parsed.action !== "rename") return { action: parsed.action, confidence: parsed.confidence }
    const title = sanitizeTitle(parsed.title)
    return title ? { action: "rename", confidence: parsed.confidence, title } : null
  } catch {
    return null
  }
}
