import type { AI } from "@threahq/agent-runtime"
import type { KnowledgeType } from "@threahq/types"
import type { ConfigResolver } from "../../lib/ai/config-resolver"
import { COMPONENT_PATHS } from "../../lib/ai/config-resolver"
import { MessageFormatter } from "../../lib/ai/message-formatter"
import type { Message } from "../messaging"
import type { Memo } from "./repository"
import {
  memoSetSchema,
  getMemorizerSystemPrompt,
  MEMORIZER_CONVERSATION_PROMPT,
  MEMORIZER_REVISION_PROMPT,
  MEMORIZER_EXISTING_TAGS_TEMPLATE,
} from "./config"

/**
 * Resolve the model's cited source messages against the messages it was actually
 * shown. Invented ids are dropped. If nothing valid remains, anchor to the single
 * most-recent message (by createdAt) rather than the whole conversation: a memo
 * smeared across every message mis-attributes one topic to an entire multi-topic
 * exchange, which is the wrong-attribution footgun this guards. `messages` order
 * is not guaranteed chronological (findByIds returns a Map), so pick by timestamp.
 */
export function resolveSourceMessageIds(citedIds: string[], messages: Pick<Message, "id" | "createdAt">[]): string[] {
  const present = new Set(messages.map((m) => m.id))
  const valid = citedIds.filter((id) => present.has(id))
  if (valid.length > 0) return valid
  if (messages.length === 0) return []
  const mostRecent = messages.reduce((a, b) => (b.createdAt > a.createdAt ? b : a))
  return [mostRecent.id]
}

/** A single single-topic memo whose abstract is self-contained and can stand alone (GAM paper). */
export interface MemoContent {
  title: string
  abstract: string
  knowledgeType: KnowledgeType
  keyPoints: string[]
  tags: string[]
  sourceMessageIds: string[]
  /**
   * Existing memos this revision explicitly retires (a reversed/replaced
   * conclusion). Validated against the conversation's own memos — embedding
   * distance can't catch a reversal ("chose X" vs "chose Y" embed far apart),
   * so the model names the retired memo directly.
   */
  supersedesMemoIds: string[]
}

export interface MemorizerContext {
  /** Prior abstracts, fed to the model for vocabulary consistency. */
  memoryContext: string[]
  content: Message | Message[]
  /** Active memos already attached to this conversation (for the regenerate-on-revision path). */
  existingMemos?: Memo[]
  existingTags?: string[]
  /** Required for AI cost attribution */
  workspaceId: string
  /**
   * Stream whose conversation is being memorized — threaded as a `disclose`
   * subject ref (design §7.3). Explicit because reflective capture passes
   * `content: []` (its source is the session anchor, not per-message ids), so
   * the ref cannot be derived from the messages.
   */
  streamId?: string
  /** Conversation whose messages are being memorized — threaded as a `disclose` subject ref (design §7.3). */
  conversationId?: string
  /** Author's timezone for date anchoring (IANA identifier, e.g., "America/New_York") */
  authorTimezone?: string
  /**
   * Canonical language for every memo (language name or BCP-47 tag). When set,
   * memos are written in this language regardless of the conversation's; when
   * omitted, memos follow the conversation's language.
   */
  memoLanguage?: string | null
}

export class Memorizer {
  constructor(
    private ai: AI,
    private configResolver: ConfigResolver,
    private messageFormatter: MessageFormatter
  ) {}

  /**
   * Extract the set of single-topic memos worth remembering from a conversation.
   * Returns one memo per distinct topic; an empty array means nothing was worth keeping.
   */
  async memorizeConversation(formattedMessages: string, context: MemorizerContext): Promise<MemoContent[]> {
    const prompt = MEMORIZER_CONVERSATION_PROMPT.replace("{{MEMORY_CONTEXT}}", this.formatMemoryContext(context))
      .replace("{{MESSAGES}}", formattedMessages)
      .replace("{{EXISTING_TAGS_SECTION}}", this.formatExistingTags(context))

    return this.generateMemoSet(prompt, context, formattedMessages, {
      functionId: "memorize-conversation",
    })
  }

  /**
   * Memorize a conversation that already has memos: emit only the topics that are
   * new or changed since them. Existing memos are passed as context so unchanged
   * topics are not re-emitted; they are left untouched (additive, no supersession).
   */
  async reviseMemo(formattedMessages: string, context: MemorizerContext): Promise<MemoContent[]> {
    const existingMemos = context.existingMemos ?? []

    const prompt = MEMORIZER_REVISION_PROMPT.replace("{{MEMORY_CONTEXT}}", this.formatMemoryContext(context))
      .replace("{{EXISTING_MEMOS}}", this.formatExistingMemos(existingMemos))
      .replace("{{MESSAGES}}", formattedMessages)
      .replace("{{EXISTING_TAGS_SECTION}}", this.formatExistingTags(context))

    return this.generateMemoSet(prompt, context, formattedMessages, {
      functionId: "revise-memo",
      metadata: { existingMemoCount: existingMemos.length },
    })
  }

  private async generateMemoSet(
    prompt: string,
    context: MemorizerContext,
    formattedMessages: string,
    telemetry: { functionId: string; metadata?: Record<string, unknown> }
  ): Promise<MemoContent[]> {
    const config = await this.configResolver.resolve(COMPONENT_PATHS.MEMO_MEMORIZER)
    const messages = context.content as Message[]
    const messageCount = formattedMessages.split("<message").length - 1
    const validSupersedeIds = new Set((context.existingMemos ?? []).map((m) => m.id))

    const { value } = await this.ai.generateObject({
      model: config.modelId,
      schema: memoSetSchema,
      messages: [
        { role: "system", content: getMemorizerSystemPrompt(context.authorTimezone, context.memoLanguage) },
        { role: "user", content: prompt },
      ],
      temperature: config.temperature,
      telemetry: {
        functionId: telemetry.functionId,
        metadata: { messageCount, ...telemetry.metadata, subjectRefs: this.buildSubjectRefs(context, messages) },
      },
      context: { workspaceId: context.workspaceId, origin: "system" },
    })

    return value.memos.map((memo) => ({
      title: memo.title,
      abstract: memo.abstract,
      knowledgeType: memo.knowledgeType,
      keyPoints: memo.keyPoints,
      tags: memo.tags,
      sourceMessageIds: resolveSourceMessageIds(memo.sourceMessageIds, messages),
      supersedesMemoIds: (memo.supersedesMemoIds ?? []).filter((id) => validSupersedeIds.has(id)),
    }))
  }

  /**
   * Subject refs for the egress's `disclose` row: the conversation's stream (all
   * messages in a conversation share it) plus the conversation id when scoped, so
   * breach queries can link this egress back to the data subject (design §7.3).
   */
  private buildSubjectRefs(context: MemorizerContext, messages: Message[]): { type: string; id: string }[] {
    const refs: { type: string; id: string }[] = []
    const streamId = context.streamId ?? messages[0]?.streamId
    if (streamId) refs.push({ type: "stream", id: streamId })
    if (context.conversationId) refs.push({ type: "conversation", id: context.conversationId })
    return refs
  }

  private formatMemoryContext(context: MemorizerContext): string {
    return context.memoryContext.length > 0
      ? context.memoryContext.map((a, i) => `${i + 1}. ${a}`).join("\n")
      : "No prior memos in this stream yet."
  }

  private formatExistingMemos(existingMemos: Memo[]): string {
    if (existingMemos.length === 0) {
      return "None."
    }
    // Ids are rendered so a reversal can name the memo it retires (supersedesMemoIds).
    return existingMemos.map((m, i) => `${i + 1}. [${m.id}] ${m.title}\n   ${m.abstract}`).join("\n")
  }

  private formatExistingTags(context: MemorizerContext): string {
    return context.existingTags?.length
      ? MEMORIZER_EXISTING_TAGS_TEMPLATE.replace("{{TAGS}}", context.existingTags.join(", "))
      : ""
  }
}
