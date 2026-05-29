import type { AI } from "@threa/agent-runtime"
import type { ConfigResolver } from "../../lib/ai/config-resolver"
import { COMPONENT_PATHS } from "../../lib/ai/config-resolver"
import { MessageFormatter } from "../../lib/ai/message-formatter"
import type { Conversation } from "../conversations"
import type { Memo } from "./repository"
import {
  conversationClassificationSchema,
  CLASSIFIER_CONVERSATION_SYSTEM_PROMPT,
  CLASSIFIER_CONVERSATION_PROMPT,
  CLASSIFIER_EXISTING_MEMO_TEMPLATE,
} from "./config"
import { formatDate } from "../../lib/temporal"
import { memoRepair } from "./repair"

/** Context for cost tracking */
export interface ClassifierContext {
  workspaceId: string
  /** Author's timezone for rendering memo timestamps (IANA identifier, e.g., "America/New_York") */
  authorTimezone?: string
}

/**
 * Classification result for conversations.
 * Determines if a conversation is knowledge-worthy and needs revision.
 */
export interface ConversationClassification {
  isKnowledgeWorthy: boolean
  shouldReviseExisting: boolean
  revisionReason: string | null
  confidence: number
}

export class MemoClassifier {
  constructor(
    private ai: AI,
    private configResolver: ConfigResolver,
    private messageFormatter: MessageFormatter
  ) {}

  async classifyConversation(
    conversation: Conversation,
    formattedMessages: string,
    existingMemos: Memo[],
    context: ClassifierContext
  ): Promise<ConversationClassification> {
    const config = await this.configResolver.resolve(COMPONENT_PATHS.MEMO_CLASSIFIER)

    const tz = context.authorTimezone ?? "UTC"
    const existingMemoSection =
      existingMemos.length > 0
        ? CLASSIFIER_EXISTING_MEMO_TEMPLATE.replace(
            "{{MEMOS}}",
            existingMemos
              .map(
                (m, i) =>
                  `${i + 1}. ${m.title} (created ${formatDate(m.createdAt, tz, "YYYY-MM-DD")})\n   ${m.abstract}`
              )
              .join("\n")
          )
        : ""

    const messageCount = formattedMessages.split("<message").length - 1

    const prompt = CLASSIFIER_CONVERSATION_PROMPT.replace("{{TOPIC}}", conversation.topicSummary ?? "No topic set")
      .replace("{{PARTICIPANTS}}", conversation.participantIds.map((id) => id.slice(-8)).join(", "))
      .replace("{{MESSAGE_COUNT}}", String(messageCount))
      .replace("{{MESSAGES}}", formattedMessages)
      .replace("{{EXISTING_MEMO_SECTION}}", existingMemoSection)

    const { value } = await this.ai.generateObject({
      model: config.modelId,
      schema: conversationClassificationSchema,
      messages: [
        { role: "system", content: CLASSIFIER_CONVERSATION_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: config.temperature,
      repair: memoRepair,
      telemetry: {
        functionId: "memo-classify-conversation",
        metadata: {
          conversationId: conversation.id,
          messageCount,
          existingMemoCount: existingMemos.length,
        },
      },
      context: { workspaceId: context.workspaceId, origin: "system" },
    })

    return {
      isKnowledgeWorthy: value.isKnowledgeWorthy,
      shouldReviseExisting: existingMemos.length > 0 ? (value.shouldReviseExisting ?? false) : false,
      revisionReason: value.revisionReason ?? null,
      confidence: value.confidence ?? 0.5,
    }
  }
}
