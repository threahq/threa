import type { AI } from "@threahq/agent-runtime"
import type { ConfigResolver } from "../../lib/ai/config-resolver"
import { COMPONENT_PATHS } from "../../lib/ai/config-resolver"
import {
  suggestionSetSchema,
  getExtractorSystemPrompt,
  EXTRACTOR_USER_PROMPT,
  EXTRACTOR_EXISTING_SUGGESTIONS_TEMPLATE,
  EXTRACTOR_DISMISSED_TEMPLATE,
} from "./config"
import { suggestionRepair } from "./repair"

/** A participant the extractor may attribute an item to. */
export interface ExtractorParticipant {
  userId: string
  name: string
}

export interface ExtractorContext {
  workspaceId: string
  conversationId: string
  participants: ExtractorParticipant[]
  /** Titles already suggested for this conversation — avoid re-emitting. */
  existingSuggestionTitles: string[]
  /** Recently dismissed titles in this stream — negative examples. */
  dismissedTitles: string[]
  /** Assignee's timezone for date anchoring (IANA id). */
  authorTimezone?: string
}

/** A raw extracted action item before assignee resolution / floor filtering. */
export interface ExtractedItem {
  title: string
  context: string | null
  assigneeUserId: string | null
  dueAtIso: string | null
  sourceMessageIds: string[]
  confidence: number
}

/**
 * Extracts action items from a conversation. Mirrors `MemoClassifier`'s shape
 * (config-resolved model, telemetry metadata, JSON repair) so the two ride the
 * same AI wrapper conventions. Pure AI — no DB access (INV-41); the caller
 * resolves assignees against participants and applies the confidence floor.
 */
export class SuggestionExtractor {
  constructor(
    private ai: AI,
    private configResolver: ConfigResolver
  ) {}

  async extract(formattedMessages: string, context: ExtractorContext): Promise<ExtractedItem[]> {
    const participantBlock = context.participants.map((p) => `- ${p.name} (id: ${p.userId})`).join("\n")

    const existingSection =
      context.existingSuggestionTitles.length > 0
        ? EXTRACTOR_EXISTING_SUGGESTIONS_TEMPLATE.replace(
            "{{SUGGESTIONS}}",
            context.existingSuggestionTitles.map((t) => `- ${t}`).join("\n")
          )
        : ""

    const dismissedSection =
      context.dismissedTitles.length > 0
        ? EXTRACTOR_DISMISSED_TEMPLATE.replace(
            "{{SUGGESTIONS}}",
            context.dismissedTitles.map((t) => `- ${t}`).join("\n")
          )
        : ""

    const prompt = EXTRACTOR_USER_PROMPT.replace("{{PARTICIPANTS}}", participantBlock || "(none listed)")
      .replace("{{MESSAGES}}", formattedMessages)
      .replace("{{EXISTING_SUGGESTIONS_SECTION}}", existingSection)
      .replace("{{DISMISSED_SECTION}}", dismissedSection)

    const config = await this.configResolver.resolve(COMPONENT_PATHS.SUGGESTION_EXTRACTOR)

    const { value } = await this.ai.generateObject({
      model: config.modelId,
      schema: suggestionSetSchema,
      messages: [
        { role: "system", content: getExtractorSystemPrompt(context.authorTimezone) },
        { role: "user", content: prompt },
      ],
      temperature: config.temperature,
      repair: suggestionRepair,
      telemetry: {
        functionId: "suggestion-extract",
        metadata: {
          conversationId: context.conversationId,
          participantCount: context.participants.length,
        },
      },
      context: { workspaceId: context.workspaceId, origin: "system" },
    })

    return value.items.map((item) => ({
      title: item.title,
      context: item.context,
      assigneeUserId: item.assigneeUserId,
      dueAtIso: item.dueAtIso,
      sourceMessageIds: item.sourceMessageIds,
      confidence: item.confidence,
    }))
  }
}
