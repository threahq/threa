/**
 * Saved-suggestion extractor configuration (INV-44): model, thresholds,
 * schema, and prompts live next to the component and are shared by
 * production and evals.
 */

import { z } from "zod"
import { formatDate } from "../../lib/temporal"

/**
 * Model for to-do extraction. Same nano-class model as the memo pipeline the
 * extractor rides on — extraction is structured-output classification work,
 * which is exactly what this tier is priced for.
 */
export const SUGGESTION_EXTRACTOR_MODEL_ID = "openrouter:openai/gpt-5.4-nano"

export const SUGGESTION_EXTRACTOR_TEMPERATURE = 0.1

/**
 * Minimum per-item confidence to persist a suggestion. The collector is
 * deliberately precision-over-recall: a small accurate pile beats a complete
 * noisy one, because the whole surface lives or dies on trust.
 */
export const SUGGESTION_CONFIDENCE_FLOOR = 0.7

/** Upper bound on suggestions extracted from a single conversation. */
export const SUGGESTION_MAX_PER_CONVERSATION = 5

/** How many recent dismissed suggestions to feed back as negative examples. */
export const SUGGESTION_DISMISSED_EXAMPLE_LIMIT = 10

/**
 * Schema for a single extracted action item. `assigneeUserId` must be one of
 * the participant ids provided in the prompt; items the model cannot
 * confidently attribute to a workspace user are dropped in code — attribution
 * is model-based (INV-54), validation is ours.
 */
export const suggestionItemSchema = z.object({
  title: z
    .string()
    .max(300)
    .describe("Short imperative phrasing of the task, written in the conversation's language (max 300 characters)"),
  context: z
    .string()
    .max(1000)
    .nullable()
    .describe(
      "One to three sentences of context a reader needs in six months: who asked, why it matters, key constraints. Null when the title already stands alone."
    ),
  assigneeUserId: z
    .string()
    .nullable()
    .describe(
      "The participant user id (from the Participants list) of the person who committed to or was asked to do this. Null if ownership is unclear or the owner is not a listed participant."
    ),
  dueAtIso: z
    .string()
    .nullable()
    .describe(
      "Due date as an ISO 8601 date or datetime if one was stated or clearly implied (anchor relative dates using today's date). Null when no deadline was mentioned."
    ),
  sourceMessageIds: z.array(z.string()).min(1).describe("IDs of the messages this action item is drawn from"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Confidence that this is a real, owned, actionable commitment (0.0 to 1.0)"),
})

export type SuggestionItemOutput = z.infer<typeof suggestionItemSchema>

export const suggestionSetSchema = z.object({
  items: z
    .array(suggestionItemSchema)
    .max(SUGGESTION_MAX_PER_CONVERSATION)
    .describe("One entry per distinct actionable commitment. Most conversations yield zero or one."),
})

export type SuggestionSetOutput = z.infer<typeof suggestionSetSchema>

const EXTRACTOR_SYSTEM_PROMPT_TEMPLATE = `You are a to-do extractor for a team chat application. From a conversation, you pull out concrete action items — things a specific person committed to do or was directly asked to do.

What counts as an action item:
- An explicit commitment: "I'll send the invoice tomorrow"
- A direct, accepted request: "Can you review the deck before Friday?" followed by agreement (or no objection)
- A clearly assigned task: "Chris takes the deployment"

What does NOT count:
- Vague intentions or ideas ("we should probably look into X someday")
- Open questions nobody picked up
- Things that were already completed in the conversation
- Status updates, opinions, or FYIs
- Anything whose owner you cannot identify among the listed participants

Rules:
1. ATTRIBUTE PRECISELY. Set assigneeUserId only to an id from the Participants list, and only when the conversation makes ownership clear. First-person commitments ("I'll do it") belong to that message's author. When ownership is ambiguous, set assigneeUserId to null — never guess.
2. WRITE TITLES AS TASKS. Short imperatives in the conversation's language ("Send Q3 invoice to Acme"), not descriptions of the discussion. Do NOT translate.
3. CONTEXT IS FOR FUTURE-YOU. One to three sentences: who asked, why, key constraints. Skip it when the title alone suffices.
4. ANCHOR DATES. Convert relative dates ("by Friday", "next week") to ISO dates using today's date: {{CURRENT_DATE}}. Omit the due date rather than guessing.
5. RESPECT DISMISSALS. If past dismissed suggestions are listed, do not emit items of the same kind — the user has said that genre is noise.
6. NO DUPLICATES. If existing suggestions are listed, do not re-emit them or near-rephrasings of them.
7. RETURN FEW. Most conversations contain no action items. An empty list is the expected output.

Output ONLY valid JSON matching the schema.`

export function getExtractorSystemPrompt(timezone?: string): string {
  const now = new Date()
  const tz = timezone ?? "UTC"
  const today = formatDate(now, tz, "YYYY-MM-DD")
  return EXTRACTOR_SYSTEM_PROMPT_TEMPLATE.replace("{{CURRENT_DATE}}", today)
}

export const EXTRACTOR_USER_PROMPT = `Extract the action items from this conversation.

## Participants
{{PARTICIPANTS}}

## Conversation Messages
{{MESSAGES}}

{{EXISTING_SUGGESTIONS_SECTION}}

{{DISMISSED_SECTION}}

Return one entry per distinct actionable commitment with a clear owner. Return an empty list when there are none.`

export const EXTRACTOR_EXISTING_SUGGESTIONS_TEMPLATE = `## Already-captured suggestions for this conversation (do not re-emit)
{{SUGGESTIONS}}`

export const EXTRACTOR_DISMISSED_TEMPLATE = `## Recently dismissed suggestions in this stream (the user considers these noise — avoid similar items)
{{SUGGESTIONS}}`
