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
  /**
   * The user this turn's guarded tools act AS — the same id the tool's deps are
   * bound to. Only this person can authorize; everyone else in the window is
   * context. Without it the guardian sees a flat list of `user:` lines and
   * cannot tell a request from the bound principal apart from one typed by
   * another participant mid-turn, which in a channel is a live path to a
   * delegation running under the wrong person's credentials.
   *
   * Undefined on turns with no human trigger — which also have no guarded
   * tools, since every one of them requires an invoking user.
   */
  invokingUserId?: string
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

/**
 * Render the tool's arguments for review, truncating PER STRING FIELD rather
 * than once over the serialized whole.
 *
 * A single budget over `JSON.stringify` output is attackable: escaping is what
 * gets truncated, not content. A valid 19,996-char brief full of backslashes
 * serializes to 40,033 chars, so a whole-output cap silently dropped its tail
 * while every field was individually within its own limit — the guardian then
 * approves a prefix of what actually executes. Bounding each field before
 * serialization means escaping can inflate the rendering but can never push
 * another field's content out of view.
 */
export function renderGuardianArguments(input: unknown): string {
  const bounded = boundStrings(input, 0)
  return JSON.stringify(bounded, null, 2) ?? String(bounded)
}

/**
 * Depth-limited so a pathological nesting can't blow the stack; past the limit
 * the value is replaced by a marker rather than dropped, since "there was more
 * here" is itself evidence the guardian needs.
 */
const MAX_ARGUMENT_DEPTH = 8

function boundStrings(value: unknown, depth: number): unknown {
  if (typeof value === "string") return truncate(value, TOOL_GUARDIAN_ARGUMENT_CHARS)
  if (value === null || typeof value !== "object") return value
  if (depth >= MAX_ARGUMENT_DEPTH) return "… [nested too deeply to render]"
  if (Array.isArray(value)) return value.map((item) => boundStrings(item, depth + 1))
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, boundStrings(item, depth + 1)]))
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
    // Enforced here, not left to the prompt. With no bound principal there is
    // nobody who could have authorized this, so no conversation can justify it
    // — and a model asked to reason about "(unknown)" will sometimes decide the
    // request looks reasonable anyway. Every guarded tool requires an invoking
    // user to be built at all, so reaching this is a wiring fault, and denying
    // is the same fail-closed direction the runtime takes on a throw.
    const principal = this.turn.invokingUserId
    if (!principal) {
      logger.error(
        { toolName: request.toolName, sessionId: this.turn.sessionId },
        "Tool guardian asked to review a guarded call with no invoking user"
      )
      return {
        allowed: false,
        reason: "This turn has no user who could authorize the action, so it was not taken.",
      }
    }

    const config = await this.deps.configResolver.resolve(COMPONENT_PATHS.TOOL_GUARDIAN)

    // Every substitution uses a REPLACER FUNCTION, never a replacement string.
    // `String.replace` expands `$\'`, `` $` ``, `$&` and `$1` inside a string
    // replacement, so attacker-authored text containing `$\'` splices the
    // template's own tail back in — measured: a participant's message ended up
    // rendered AFTER "Respond with ONLY the JSON object", the most influential
    // position in the prompt. A function replacement disables the whole `$`
    // grammar. Every value here is model- or participant-authored.
    const prompt = TOOL_GUARDIAN_PROMPT.replace("{{TOOL_NAME}}", () => request.toolName)
      .replace("{{TOOL_DESCRIPTION}}", () => request.toolDescription)
      .replace("{{TOOL_ARGUMENTS}}", () => renderGuardianArguments(request.input))
      .replace("{{CONVERSATION}}", () => renderGuardianConversation(request.messages))
      .replace("{{PRINCIPAL}}", () => principal)

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
