import type { LanguageModel, ModelMessage, Tool, ToolResultPart } from "ai"
import type { SourceItem, TraceSource } from "@threa/types"
import { AgentToolNames } from "@threa/types"
import type { AI, CostContext } from "../ai/ai"
import { logger } from "../logger"
import { protectToolOutputText } from "./tool-trust-boundary"
import { MAX_MESSAGE_CHARS, truncateMessages } from "./truncation"
import { createKeepResponseTool } from "../tools/keep-response-tool"
import { createSendMessageTool } from "../tools/send-message-tool"
import type { AgentTool, AgentToolResult } from "./agent-tool"
import { toVercelToolDefs } from "./agent-tool"
import type { AgentEvent, NewMessageInfo } from "./agent-events"
import type { AgentObserver } from "./agent-observer"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ITERATIONS = 20
const KEEP_RESPONSE_TOOL_NAME = "keep_response"
const MAX_REPEATED_INVALID_DRAFTS = 3
const MAX_EMPTY_FINAL_DECISION_ATTEMPTS = 3

export interface NewMessageAwareness {
  check: (streamId: string, sinceSequence: bigint, excludeAuthorId: string) => Promise<NewMessageInfo[]>
  updateSequence: (sessionId: string, sequence: bigint) => Promise<void>
  awaitAttachments: (messageIds: string[]) => Promise<void>
  streamId: string
  sessionId: string
  personaId: string
  lastProcessedSequence: bigint
}

/**
 * The slice of `AI` the loop actually calls. Narrowed from the full wrapper so
 * alternative hosts (e.g. the enclave) can supply just `generateTextWithTools`
 * over their own transport without implementing — or bundling — the embeddings,
 * cost, and telemetry surface of the production `createAI`. The backend's full
 * `AI` still satisfies this by structural subtyping.
 */
export type AgentRuntimeAI = Pick<AI, "generateTextWithTools">

export interface AgentRuntimeConfig {
  ai: AgentRuntimeAI
  model: LanguageModel
  /**
   * Original provider:model string for `model`. Required alongside `costContext`
   * for AI usage tracking — the resolved LanguageModel does not expose the
   * prefix the cost recorder needs.
   */
  modelString?: string
  systemPrompt: string
  messages: ModelMessage[]
  tools: AgentTool[]
  maxTokens?: number | null
  temperature?: number | null
  maxIterations?: number
  observers?: AgentObserver[]
  telemetry?: { functionId: string; metadata?: Record<string, string | number | boolean> }
  /** Cost context forwarded to every AI call the runtime makes (enables usage recording). */
  costContext?: CostContext

  /** Terminal action — sends a message to the conversation */
  sendMessage: (input: {
    content: string
    sources?: SourceItem[]
  }) => Promise<{ messageId: string; operation?: "created" | "edited" }>

  /** Optional new-message awareness (companion uses this, simpler agents don't) */
  newMessages?: NewMessageAwareness

  /** Optional cancellation hook (e.g., when session was externally deleted/superseded). */
  shouldAbort?: () => Promise<string | null>

  /**
   * Optional per-tool-call AbortSignal provider. Returned signals are passed into
   * the tool's `execute` via `opts.signal`. Unlike `shouldAbort` (which throws and
   * kills the session), this is a cooperative cancellation channel for tools that
   * can return partial results gracefully.
   */
  toolSignalProvider?: (toolCallId: string, toolName: string) => AbortSignal | undefined

  /**
   * Allow sessions to complete without sending a new message.
   * Used for supersede reruns where retaining prior responses is a valid outcome.
   */
  allowNoMessageOutput?: boolean

  /**
   * Optional validation hook for candidate final responses.
   * Return a reason string to reject and force another iteration.
   */
  validateFinalResponse?: (content: string) => Promise<string | null> | string | null
}

export interface AgentRuntimeResult {
  messagesSent: number
  sentMessageIds: string[]
  sentContents: string[]
  lastProcessedSequence: bigint
  sources: SourceItem[]
  noMessageReason?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PendingMessage {
  content: string
  sources?: SourceItem[]
}

function extractAssistantText(result: { text: string; response: { messages: ModelMessage[] } }): string | undefined {
  if (result.text.trim()) return result.text.trim()

  const assistantMsg = result.response.messages[0]
  if (!assistantMsg || assistantMsg.role !== "assistant") return undefined

  if (typeof assistantMsg.content === "string") return assistantMsg.content.trim() || undefined
  if (Array.isArray(assistantMsg.content)) {
    const text = (assistantMsg.content as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text!)
      .join("")
    return text.trim() || undefined
  }
  return undefined
}

export function mergeSourceItems(existing: SourceItem[], incoming: SourceItem[]): SourceItem[] {
  if (incoming.length === 0) return existing
  const merged = [...existing]
  const seen = new Set(merged.map((s) => `${s.url}|${s.title}`))
  for (const s of incoming) {
    const key = `${s.url}|${s.title}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(s)
  }
  return merged
}

function makeToolResult(tc: { toolCallId: string; toolName: string }, value: string): ToolResultPart {
  return {
    type: "tool-result",
    toolCallId: tc.toolCallId,
    toolName: tc.toolName,
    output: { type: "text", value },
  }
}

// ---------------------------------------------------------------------------
// AgentRuntime
// ---------------------------------------------------------------------------

export class AgentRuntime {
  private readonly maxIterations: number
  private readonly observers: AgentObserver[]
  private readonly toolMap: Map<string, AgentTool>
  private readonly toolDefs: Record<string, Tool<any, any>>

  constructor(private readonly config: AgentRuntimeConfig) {
    this.maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS
    this.observers = config.observers ?? []
    this.toolMap = new Map(config.tools.map((t) => [t.name, t]))
    this.toolDefs = this.buildToolDefs()
  }

  /**
   * Build the complete set of tool definitions the LLM sees.
   * Includes all AgentTool schemas plus send_message (terminal action the runtime intercepts).
   */
  private buildToolDefs(): Record<string, Tool<any, any>> {
    const defs = toVercelToolDefs(this.config.tools)
    defs[AgentToolNames.SEND_MESSAGE] = createSendMessageTool()
    if (this.config.allowNoMessageOutput) {
      defs[KEEP_RESPONSE_TOOL_NAME] = createKeepResponseTool()
    }
    return defs
  }

  async run(): Promise<AgentRuntimeResult> {
    const nm = this.config.newMessages

    // Emit session start
    const inputSummary = this.extractInputSummary()
    await this.emit({ type: "session:start", sessionId: nm?.sessionId ?? "", inputSummary })

    try {
      const result = await this.loop()
      await this.emit({
        type: "session:end",
        messagesSent: result.messagesSent,
        sourceCount: result.sources.length,
        lastContent: result.sentContents.at(-1),
      })
      return result
    } catch (error) {
      await this.emit({ type: "session:error", error: String(error) })
      throw error
    } finally {
      for (const observer of this.observers) {
        try {
          await observer.cleanup?.()
        } catch (err) {
          logger.warn({ err }, "Observer cleanup failed")
        }
      }
    }
  }

  private async loop(): Promise<AgentRuntimeResult> {
    const { ai, model, systemPrompt } = this.config
    const nm = this.config.newMessages

    const conversation: ModelMessage[] = [...this.config.messages]
    const sent = { ids: [] as string[], contents: [] as string[] }
    let messagesSent = 0
    let sources: SourceItem[] = []
    let retrievedContext: string | null = null
    let lastAssistantText: string | undefined
    // Most recent non-empty assistant text observed across the loop, including
    // text emitted alongside tool calls. Used as a fallback so that a session
    // can never end with 0 messages when the model actually said something
    // user-facing — covers the case where reconsideration ends in keep_response
    // but earlier iterations produced real content.
    let lastContentStep: string | null = null
    let hasTextReconsidered = false
    let lastProcessedSequence = nm?.lastProcessedSequence ?? BigInt(0)
    let keptResponseReason: string | null = null
    let repeatedInvalidDraftCount = 0
    let lastInvalidDraft: string | null = null
    let emptyFinalDecisionAttempts = 0

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      const abortReason = await this.config.shouldAbort?.()
      if (abortReason) {
        throw new Error(`Agent session aborted: ${abortReason}`)
      }

      const fullSystemPrompt = retrievedContext ? `${systemPrompt}\n\n${retrievedContext}` : systemPrompt
      const preparedConversation = this.prepareConversationForModel(conversation)
      const truncatedMessages = truncateMessages(preparedConversation, MAX_MESSAGE_CHARS)

      const startTime = Date.now()
      const result = await this.wrapWithObserverContext(() =>
        ai.generateTextWithTools({
          model,
          modelString: this.config.modelString,
          system: fullSystemPrompt,
          messages: truncatedMessages,
          tools: this.toolDefs,
          maxTokens: this.config.maxTokens ?? undefined,
          temperature: this.config.temperature ?? undefined,
          telemetry: this.config.telemetry,
          context: this.config.costContext,
        })
      )
      const durationMs = Date.now() - startTime

      // Record thinking
      if (result.text.trim() || result.toolCalls.length > 0) {
        const thinkingContent = result.text.trim()
          ? result.text
          : JSON.stringify({ toolPlan: result.toolCalls.map((tc: { toolName: string }) => tc.toolName) })
        await this.emit({ type: "thinking", content: thinkingContent, durationMs })
      }

      if (result.text.trim()) {
        lastContentStep = result.text.trim()
      }

      // Add assistant message to conversation
      const assistantMsg = result.response.messages[0]
      if (assistantMsg) conversation.push(assistantMsg)

      // ── Text-only response (no tool calls) ──
      if (result.toolCalls.length === 0) {
        const currentText = extractAssistantText(result)
        if (currentText) {
          lastAssistantText = currentText
          emptyFinalDecisionAttempts = 0
        }

        if (nm) {
          const newMessages = await nm.check(nm.streamId, lastProcessedSequence, nm.personaId)
          if (newMessages.length > 0) {
            const maxSeq = await this.injectNewMessages(newMessages, lastProcessedSequence, nm, conversation)
            lastProcessedSequence = maxSeq

            if (!hasTextReconsidered && lastAssistantText) {
              hasTextReconsidered = true
              this.pushRuntimePrompt(
                conversation,
                `[New context arrived while you were responding]\n\n` +
                  `Your draft response was:\n"${lastAssistantText}"\n\n` +
                  `Please incorporate the new messages and respond.`
              )
              continue
            }
          }
        }

        if (lastAssistantText) {
          const validationError = this.config.validateFinalResponse
            ? await this.config.validateFinalResponse(lastAssistantText)
            : null
          if (validationError) {
            if (lastInvalidDraft === lastAssistantText) {
              repeatedInvalidDraftCount += 1
            } else {
              lastInvalidDraft = lastAssistantText
              repeatedInvalidDraftCount = 1
            }

            if (this.config.allowNoMessageOutput && repeatedInvalidDraftCount >= MAX_REPEATED_INVALID_DRAFTS) {
              keptResponseReason =
                "Kept the previous response because revised drafts repeatedly failed validation after context updates."
              break
            }

            this.pushRuntimePrompt(
              conversation,
              `[Final response needs revision]\n\n` +
                `${validationError}\n\n` +
                `Your proposed response was:\n"${lastAssistantText}"\n\n` +
                `Please provide a revised final response now.`
            )
            continue
          }

          repeatedInvalidDraftCount = 0
          lastInvalidDraft = null
          const committed = await this.commitMessage({ content: lastAssistantText, sources }, sent)
          messagesSent += committed
        }
        if (!lastAssistantText && this.config.allowNoMessageOutput) {
          emptyFinalDecisionAttempts += 1
          if (emptyFinalDecisionAttempts >= MAX_EMPTY_FINAL_DECISION_ATTEMPTS) {
            keptResponseReason =
              "Kept the previous response because the rerun produced no actionable output after repeated attempts."
            break
          }

          this.pushRuntimePrompt(
            conversation,
            `[Final decision required]\n\n` +
              `You must choose one final action now.\n` +
              `- If previous responses remain correct, call keep_response with a specific reason tied to the edited message.\n` +
              `- If changes are needed, call send_message with the revised response.\n` +
              `Do not return an empty response.`
          )
          continue
        }
        break
      }

      // ── Tool calls present ──
      const execResult = await this.executeToolCalls(
        result.toolCalls.map((tc: { toolCallId: string; toolName: string; input: unknown }) => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
        })),
        sources,
        retrievedContext
      )
      sources = execResult.sources
      retrievedContext = execResult.retrievedContext

      if (execResult.resultParts.length > 0) {
        conversation.push({ role: "tool", content: execResult.resultParts })
      }
      conversation.push(...execResult.extraMessages)

      // --- Finalize or reconsider ---
      if (nm) {
        const newMessages = await nm.check(nm.streamId, lastProcessedSequence, nm.personaId)

        if (execResult.pendingMessages.length > 0) {
          if (newMessages.length === 0) {
            const invalidPending = await this.findInvalidPendingMessage(execResult.pendingMessages)
            if (invalidPending) {
              this.pushRuntimePrompt(
                conversation,
                `[Final response needs revision]\n\n` +
                  `${invalidPending.reason}\n\n` +
                  `Your proposed response was:\n"${invalidPending.content}"\n\n` +
                  `Please provide a revised final response and call send_message again.`
              )
              continue
            }

            for (const pending of execResult.pendingMessages) {
              const committed = await this.commitMessage(
                { content: pending.content, sources: pending.sources ?? [] },
                sent
              )
              messagesSent += committed
            }
            break
          } else {
            const maxSeq = await this.injectNewMessages(newMessages, lastProcessedSequence, nm, conversation)
            lastProcessedSequence = maxSeq

            const pendingContents = execResult.pendingMessages.map((p) => p.content).join("\n---\n")
            await this.emit({
              type: "reconsidering",
              draft: pendingContents,
              newMessages,
            })

            this.pushRuntimePrompt(
              conversation,
              `[New context arrived while you were responding]\n\n` +
                `Your draft response${execResult.pendingMessages.length > 1 ? "s were" : " was"}:\n"${pendingContents}"\n\n` +
                `Please respond to all messages, incorporating the new context. ` +
                `You may send the same response${execResult.pendingMessages.length > 1 ? "s" : ""} if still appropriate, or revise based on the new information.`
            )
          }
        } else if (execResult.keepResponseReason) {
          if (newMessages.length === 0) {
            keptResponseReason = execResult.keepResponseReason
            // Don't emit response:kept here — defer until after the loop so
            // that, if we end up falling back to a captured content step, the
            // trace reflects the message we sent rather than a misleading
            // "kept previous response" step.
            break
          }

          const maxSeq = await this.injectNewMessages(newMessages, lastProcessedSequence, nm, conversation)
          lastProcessedSequence = maxSeq

          await this.emit({
            type: "reconsidering",
            draft: `[No change decision]\nReason: ${execResult.keepResponseReason}`,
            newMessages,
          })

          this.pushRuntimePrompt(
            conversation,
            `[New context arrived after you decided to keep the existing response]\n\n` +
              `Your keep-response reason was:\n"${execResult.keepResponseReason}"\n\n` +
              `Please reconsider. If the previous response is still correct, call keep_response again with an updated reason. ` +
              `If changes are needed, call send_message with the updated response.`
          )
        } else if (newMessages.length > 0) {
          const maxSeq = await this.injectNewMessages(newMessages, lastProcessedSequence, nm, conversation)
          lastProcessedSequence = maxSeq
        }
      } else {
        // No new-message awareness — commit pending messages immediately
        if (execResult.pendingMessages.length > 0) {
          const invalidPending = await this.findInvalidPendingMessage(execResult.pendingMessages)
          if (invalidPending) {
            this.pushRuntimePrompt(
              conversation,
              `[Final response needs revision]\n\n` +
                `${invalidPending.reason}\n\n` +
                `Your proposed response was:\n"${invalidPending.content}"\n\n` +
                `Please provide a revised final response and call send_message again.`
            )
            continue
          }

          for (const pending of execResult.pendingMessages) {
            const committed = await this.commitMessage(
              { content: pending.content, sources: pending.sources ?? [] },
              sent
            )
            messagesSent += committed
          }
          break
        }

        if (execResult.keepResponseReason) {
          keptResponseReason = execResult.keepResponseReason
          // Defer response:kept emit; see equivalent comment above.
          break
        }
      }
    }

    // Fallback: if the loop ended without committing a message but the model
    // produced real assistant text along the way (e.g. a thinking step that
    // was actually user-directed content like "Found it! You shared this in
    // your Casual Greeting conversation"), commit that content. Otherwise an
    // edit-triggered rerun whose chain ends in a reconsider/keep_response
    // would silently emit nothing.
    if (sent.ids.length === 0 && lastContentStep) {
      const validationError = this.config.validateFinalResponse
        ? await this.config.validateFinalResponse(lastContentStep)
        : null
      if (!validationError) {
        const committed = await this.commitMessage({ content: lastContentStep, sources }, sent)
        messagesSent += committed
        keptResponseReason = null
      }
    }

    if (sent.ids.length === 0) {
      if (this.config.allowNoMessageOutput) {
        const noMessageReason =
          keptResponseReason ?? "The existing response still fit the updated context, so no message changes were made."

        await this.emit({
          type: "response:kept",
          reason: noMessageReason,
        })

        logger.info(
          { sessionId: nm?.sessionId, streamId: nm?.streamId, iterations: this.maxIterations },
          "Agent run completed without sending a message"
        )
        return {
          messagesSent,
          sentMessageIds: sent.ids,
          sentContents: sent.contents,
          lastProcessedSequence,
          sources,
          noMessageReason,
        }
      }

      logger.error(
        { sessionId: nm?.sessionId, streamId: nm?.streamId, iterations: this.maxIterations },
        "Agent loop exhausted iterations without sending a message"
      )
      throw new Error("Agent loop completed without sending a message")
    }

    return { messagesSent, sentMessageIds: sent.ids, sentContents: sent.contents, lastProcessedSequence, sources }
  }

  // ---------------------------------------------------------------------------
  // Tool execution
  // ---------------------------------------------------------------------------

  private async executeToolCalls(
    toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>,
    currentSources: SourceItem[],
    currentContext: string | null
  ): Promise<{
    resultParts: ToolResultPart[]
    extraMessages: ModelMessage[]
    pendingMessages: PendingMessage[]
    keepResponseReason: string | null
    sources: SourceItem[]
    retrievedContext: string | null
  }> {
    const resultParts: ToolResultPart[] = []
    const extraMessages: ModelMessage[] = []
    const pendingMessages: PendingMessage[] = []
    let keepResponseReason: string | null = null
    let sources = currentSources
    let retrievedContext = currentContext

    // Order: early-phase tools first, then normal, then send_message (staged)
    const sendMessageCalls = toolCalls.filter((tc) => tc.toolName === AgentToolNames.SEND_MESSAGE)
    const keepResponseCalls = this.config.allowNoMessageOutput
      ? toolCalls.filter((tc) => tc.toolName === KEEP_RESPONSE_TOOL_NAME)
      : []
    const agentToolCalls = toolCalls.filter(
      (tc) =>
        tc.toolName !== AgentToolNames.SEND_MESSAGE &&
        (!this.config.allowNoMessageOutput || tc.toolName !== KEEP_RESPONSE_TOOL_NAME)
    )
    const earlyCalls = agentToolCalls.filter((tc) => this.toolMap.get(tc.toolName)?.config.executionPhase === "early")
    const normalCalls = agentToolCalls.filter((tc) => this.toolMap.get(tc.toolName)?.config.executionPhase !== "early")

    for (const tc of [...earlyCalls, ...normalCalls]) {
      const agentTool = this.toolMap.get(tc.toolName)
      if (!agentTool) {
        await this.emit({
          type: "tool:error",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          error: `Unknown tool: ${tc.toolName}`,
          durationMs: 0,
        })
        resultParts.push(makeToolResult(tc, JSON.stringify({ error: `Unknown tool: ${tc.toolName}` })))
        continue
      }

      const stepType = agentTool.config.trace.stepType
      await this.emit({
        type: "tool:start",
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        stepType,
        input: tc.input,
        hidden: agentTool.config.trace.hidden,
      })
      const startTime = Date.now()

      try {
        const onProgress = (substep: string) => {
          // Fire-and-forget: don't back-pressure the tool with observer latency.
          void this.emit({
            type: "tool:progress",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            stepType,
            substep,
          })
        }
        const signal = this.config.toolSignalProvider?.(tc.toolCallId, tc.toolName)

        // Wrap the tool execute in the observer-provided tool span context
        // (OTEL) so that nested AI SDK calls inside the tool nest under the
        // tool span instead of orphaning under the root.
        const toolResult = await this.wrapToolWithObserverContext(tc.toolCallId, () =>
          agentTool.config.execute(tc.input as any, {
            toolCallId: tc.toolCallId,
            onProgress,
            signal,
          })
        )
        const durationMs = Date.now() - startTime

        // Accumulate sources
        if (toolResult.sources && toolResult.sources.length > 0) {
          sources = mergeSourceItems(sources, toolResult.sources)
        }

        // Accumulate system context
        if (toolResult.systemContext?.trim()) {
          const newCtx = toolResult.systemContext.trim()
          retrievedContext = retrievedContext ? `${retrievedContext}\n\n${newCtx}` : newCtx
        }

        // Build trace
        const traceContent = agentTool.config.trace.formatContent(tc.input, toolResult)
        const traceSources = agentTool.config.trace.extractSources?.(tc.input, toolResult)

        await this.emit({
          type: "tool:complete",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
          output: toolResult.output,
          durationMs,
          trace: { stepType: agentTool.config.trace.stepType, content: traceContent, sources: traceSources },
        })

        // Tool result → LLM
        resultParts.push(makeToolResult(tc, protectToolOutputText(toolResult.output)))

        // Multimodal media → injected as user messages (tool results are
        // text-only on the wire; images/files must ride a user turn).
        if (toolResult.multimodal && toolResult.multimodal.length > 0) {
          extraMessages.push({
            role: "user",
            content: toolResult.multimodal.map((m) =>
              m.type === "image"
                ? { type: "image" as const, image: m.url }
                : {
                    type: "file" as const,
                    data: m.data,
                    mediaType: m.mediaType,
                    ...(m.filename ? { filename: m.filename } : {}),
                  }
            ),
          })
        }
      } catch (error) {
        const durationMs = Date.now() - startTime
        await this.emit({
          type: "tool:error",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          error: String(error),
          durationMs,
        })
        resultParts.push(makeToolResult(tc, JSON.stringify({ error: String(error) })))
      }
    }

    // Stage send_message calls (prep-then-send)
    for (const tc of sendMessageCalls) {
      pendingMessages.push({
        content: (tc.input as { content: string }).content,
        sources: sources.length > 0 ? [...sources] : undefined,
      })
      resultParts.push(
        makeToolResult(
          tc,
          JSON.stringify({ status: "pending", message: "Message staged. Will be sent after checking for new context." })
        )
      )
    }

    for (const tc of keepResponseCalls) {
      const reason = (tc.input as { reason?: unknown }).reason
      keepResponseReason =
        typeof reason === "string" && reason.trim().length > 0
          ? reason.trim()
          : "No substantive changes were needed after reconsidering the updated context."
      resultParts.push(
        makeToolResult(
          tc,
          JSON.stringify({
            status: "accepted",
            message: "Keeping existing response unchanged.",
            reason: keepResponseReason,
          })
        )
      )
    }

    return { resultParts, extraMessages, pendingMessages, keepResponseReason, sources, retrievedContext }
  }

  // ---------------------------------------------------------------------------
  // Message commit
  // ---------------------------------------------------------------------------

  private async commitMessage(
    pending: { content: string; sources: SourceItem[] },
    sent: { ids: string[]; contents: string[] }
  ): Promise<number> {
    const sendResult = await this.config.sendMessage({
      content: pending.content,
      sources: pending.sources.length > 0 ? pending.sources : undefined,
    })
    const operation = sendResult.operation ?? "created"
    sent.ids.push(sendResult.messageId)
    sent.contents.push(pending.content)

    const traceSources =
      pending.sources.length > 0
        ? pending.sources.map((s) => ({
            type: (s.type ?? "web") as TraceSource["type"],
            title: s.title,
            url: s.url,
            snippet: s.snippet,
          }))
        : undefined

    await this.emit({
      type: operation === "edited" ? "message:edited" : "message:sent",
      messageId: sendResult.messageId,
      content: pending.content,
      sources: traceSources,
    })

    // User-visible response updates (both creates and edits) count as sent output.
    return 1
  }

  private async findInvalidPendingMessage(
    pendingMessages: PendingMessage[]
  ): Promise<{ content: string; reason: string } | null> {
    if (!this.config.validateFinalResponse) return null

    for (const pending of pendingMessages) {
      const reason = await this.config.validateFinalResponse(pending.content)
      if (reason) return { content: pending.content, reason }
    }

    return null
  }

  private prepareConversationForModel(conversation: ModelMessage[]): ModelMessage[] {
    const lastMessage = conversation.at(-1)
    if (!lastMessage || (lastMessage.role !== "assistant" && lastMessage.role !== "system")) {
      return conversation
    }

    const continuationPrompt = this.config.allowNoMessageOutput
      ? "Review the conversation above and follow the system instructions. Compare the latest assistant response against the updated context, then call keep_response or send_message."
      : "Continue from the conversation above and follow the system instructions."

    return [...conversation, { role: "user", content: continuationPrompt }]
  }

  private pushRuntimePrompt(conversation: ModelMessage[], content: string): void {
    conversation.push({ role: "user", content })
  }

  // ---------------------------------------------------------------------------
  // New message injection
  // ---------------------------------------------------------------------------

  private async injectNewMessages(
    newMessages: NewMessageInfo[],
    lastProcessedSequence: bigint,
    nm: NonNullable<AgentRuntimeConfig["newMessages"]>,
    conversation: ModelMessage[]
  ): Promise<bigint> {
    await nm.awaitAttachments(newMessages.map((m) => m.messageId))

    const maxSequence = newMessages.reduce((max, m) => (m.sequence > max ? m.sequence : max), lastProcessedSequence)
    await nm.updateSequence(nm.sessionId, maxSequence)

    await this.emit({ type: "context:received", messages: newMessages })

    const userMessages: ModelMessage[] = newMessages.map((m) => ({ role: "user" as const, content: m.content }))
    conversation.push(...userMessages)

    return maxSequence
  }

  // ---------------------------------------------------------------------------
  // Event emission
  // ---------------------------------------------------------------------------

  private async emit(event: AgentEvent): Promise<void> {
    for (const observer of this.observers) {
      try {
        await observer.handle(event)
      } catch (err) {
        logger.warn({ err, eventType: event.type }, "Observer failed to handle event")
      }
    }
  }

  /**
   * Compose all observers' wrapExecution hooks around an async operation.
   * Allows OTEL observer to set the active span context so that
   * child spans (e.g., from Vercel AI SDK) nest under the root span.
   */
  private async wrapWithObserverContext<T>(fn: () => Promise<T>): Promise<T> {
    let wrapped = fn
    for (const observer of this.observers) {
      if (observer.wrapExecution) {
        const prev = wrapped
        const obs = observer
        wrapped = () => obs.wrapExecution!(prev)
      }
    }
    return wrapped()
  }

  /**
   * Compose all observers' wrapToolExecution hooks around a tool's execute().
   * The OTEL observer uses this to make the tool span the active context so
   * nested AI SDK calls (e.g. workspace researcher's planner/evaluator
   * `generateObject` calls) appear as children of the tool span in Langfuse,
   * rather than orphaning.
   *
   * Must be called AFTER `tool:start` has been emitted so observers have a
   * chance to register the tool's context.
   */
  private async wrapToolWithObserverContext<T>(toolCallId: string, fn: () => Promise<T>): Promise<T> {
    let wrapped = fn
    for (const observer of this.observers) {
      if (observer.wrapToolExecution) {
        const prev = wrapped
        const obs = observer
        wrapped = () => obs.wrapToolExecution!(toolCallId, prev)
      }
    }
    return wrapped()
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private extractInputSummary(): string | undefined {
    const lastUserMsg = [...this.config.messages].reverse().find((m) => m.role === "user")
    if (!lastUserMsg) return undefined
    return typeof lastUserMsg.content === "string" ? lastUserMsg.content : JSON.stringify(lastUserMsg.content)
  }
}
