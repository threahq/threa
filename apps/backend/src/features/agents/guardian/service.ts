import type { ModelMessage } from "ai"
import type { AI, ToolGuardian, ToolGuardianRequest, ToolGuardianVerdict } from "@threa/agent-runtime"
import type { CostContext } from "@threa/agent-runtime"
import type { ConfigResolver } from "../../../lib/ai/config-resolver"
import { COMPONENT_PATHS } from "../../../lib/ai/config-resolver"
import { logger } from "../../../lib/logger"
import {
  TOOL_GUARDIAN_ARGUMENT_CHARS,
  TOOL_GUARDIAN_HISTORY_MESSAGES,
  TOOL_GUARDIAN_MESSAGE_CHARS,
  TOOL_GUARDIAN_PROMPT,
  TOOL_GUARDIAN_SYSTEM_PROMPT,
  TOOL_GUARDIAN_TIMEOUT_MS,
  toolGuardianResponseSchema,
} from "./config"

export interface ToolGuardianServiceDeps {
  ai: AI
  configResolver: ConfigResolver
}

/** Bound to one turn: what the review is for, and where its cost belongs. */
export interface ToolGuardianTurn {
  workspaceId: string
  streamId: string
  personaId: string
  sessionId: string
  costContext?: CostContext
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated]`
}

/**
 * Render one model message as a line the guardian can attribute.
 *
 * Tool results are deliberately labelled `tool result (untrusted data)`: a
 * request that appears only inside retrieved content is not the user asking,
 * and the prompt's rules lean on being able to tell the two apart.
 */
const GUARDIAN_ROLE_LABELS: Partial<Record<ModelMessage["role"], string>> = {
  user: "user",
  assistant: "assistant",
  tool: "tool result (untrusted data)",
}

function renderMessage(message: ModelMessage): string | null {
  const role = GUARDIAN_ROLE_LABELS[message.role]
  if (!role) return null

  const { content } = message
  let text: string
  if (typeof content === "string") {
    text = content
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => {
        if (typeof part === "string") return part
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text
        if (part && typeof part === "object" && "type" in part) return `[${String(part.type)}]`
        return ""
      })
      .filter(Boolean)
      .join("\n")
  } else {
    return null
  }

  const trimmed = text.trim()
  if (!trimmed) return null
  return `${role}: ${truncate(trimmed, TOOL_GUARDIAN_MESSAGE_CHARS)}`
}

export function renderGuardianConversation(messages: ModelMessage[]): string {
  const lines = messages
    .slice(-TOOL_GUARDIAN_HISTORY_MESSAGES)
    .map(renderMessage)
    .filter((line): line is string => line !== null)
  return lines.length > 0 ? lines.join("\n\n") : "(no conversation yet)"
}

/**
 * Decides whether a tier-2 tool call may run, by asking a cheap model whether
 * the conversation contains a request for it.
 *
 * Constructed once per turn with the turn's identifiers so every review is
 * attributed and costed like any other AI call (INV-19/28) — a guarded turn's
 * real cost shows up in `ai_usage_records` under `tool-guardian` rather than
 * disappearing into an unattributed side channel.
 *
 * Errors are NOT swallowed here — the runtime converts a throw into a denial,
 * so failing closed is one behaviour in one place rather than a `catch` per
 * failure mode that can quietly grow an allow-path.
 */
export class ToolGuardianService implements ToolGuardian {
  constructor(
    private readonly deps: ToolGuardianServiceDeps,
    private readonly turn: ToolGuardianTurn
  ) {}

  async review(request: ToolGuardianRequest): Promise<ToolGuardianVerdict> {
    const config = await this.deps.configResolver.resolve(COMPONENT_PATHS.TOOL_GUARDIAN)

    const prompt = TOOL_GUARDIAN_PROMPT.replace("{{TOOL_NAME}}", request.toolName)
      .replace("{{TOOL_DESCRIPTION}}", request.toolDescription)
      .replace("{{TOOL_ARGUMENTS}}", truncate(JSON.stringify(request.input, null, 2), TOOL_GUARDIAN_ARGUMENT_CHARS))
      .replace("{{CONVERSATION}}", renderGuardianConversation(request.messages))

    const { value } = await this.deps.ai.generateObject({
      model: config.modelId,
      schema: toolGuardianResponseSchema,
      messages: [
        { role: "system", content: config.systemPrompt ?? TOOL_GUARDIAN_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: config.temperature,
      abortSignal: AbortSignal.timeout(TOOL_GUARDIAN_TIMEOUT_MS),
      telemetry: {
        functionId: "tool-guardian",
        metadata: {
          toolName: request.toolName,
          streamId: this.turn.streamId,
          personaId: this.turn.personaId,
          sessionId: this.turn.sessionId,
        },
      },
      context: this.turn.costContext ?? { workspaceId: this.turn.workspaceId, origin: "system" },
    })

    logger.info(
      {
        toolName: request.toolName,
        sessionId: this.turn.sessionId,
        allowed: value.allowed,
        confidence: value.confidence,
      },
      "Tool guardian verdict"
    )

    return { allowed: value.allowed, reason: value.reason }
  }
}
