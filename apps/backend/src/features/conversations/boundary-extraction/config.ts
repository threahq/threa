/**
 * Boundary Extraction Configuration
 *
 * Co-located config following INV-43 - both production code and evals
 * import from here to ensure consistency.
 */

import { z } from "zod"
import { CONVERSATION_STATUSES } from "@threa/types"

/** Default model for boundary extraction */
export const BOUNDARY_EXTRACTION_MODEL_ID = "openrouter:openai/gpt-5.4-nano"

/** Temperature for classification - low for consistency */
export const BOUNDARY_EXTRACTION_TEMPERATURE = 0.2

/** System prompt for boundary extraction */
export const BOUNDARY_EXTRACTION_SYSTEM_PROMPT = `You are a conversation boundary classifier. You analyze messages and output ONLY valid JSON matching the required schema. No explanations, no markdown, no prose - just the JSON object.`

/** User prompt template for boundary extraction */
export const BOUNDARY_EXTRACTION_PROMPT = `Analyze this new message and decide which conversation(s) it belongs to. You may also move recent messages that were placed in the wrong conversation, now that this new message clarifies what was happening.

## Active Conversations
{{CONVERSATIONS}}

## Recent Messages
{{RECENT_MESSAGES}}

## New Message
From: {{AUTHOR}}
Content: {{CONTENT}}

## Multi-membership
A message can belong to more than one conversation. If this new message clearly continues two different ongoing threads (e.g. a single ping that references two topics), assign it to both. Pick the conversation it MOST continues as primary; the others are secondaries. Most messages have only a primary assignment — only return secondaries when the message genuinely advances two distinct conversations.

## Reassignment
If this new message reveals that one or more of the *Recent Messages* or messages from the *Active Conversations* was placed in the wrong conversation, move them. Each move needs a one-line reason. You can ONLY move messages whose IDs appear in this prompt — never any other. Examples of when to reassign:
- The new message reveals the prior 1-2 messages were the start of a different topic (sandwich case).
- The new message reopens a conversation that was prematurely marked resolved.
- The new message shows two adjacent conversations are actually the same topic — move the smaller one into the larger.

Reassignment is *the* mechanism for fixing classification mistakes. Use it whenever the new message gives you evidence the prior placement was wrong. Do not be conservative — moving a message to where it now clearly belongs is better than leaving it stranded.

## Output Requirements
- assignments: Array of {conversationId, isPrimary}. At least one entry with isPrimary=true. conversationId=null means "create a new conversation" (set newConversationTopic).
- newConversationTopic: Topic summary if any assignment has conversationId=null. Required in that case.
- reassignments: Array of {messageId, toConversationId, reason, confidence}. messageId must be from this prompt. toConversationId=null means "move into the new conversation being created this turn" (only valid if assignments includes a conversationId=null primary).
- completenessUpdates: Array of {conversationId, score (1-7), status} for conversations whose completeness changed.
  - status must be one of: "active", "stalled", "resolved"
- confidence: 0.0 to 1.0 confidence in this classification overall.

Respond with ONLY the JSON object. No explanation, no markdown code blocks.`

/**
 * Schema for LLM extraction response using structured outputs.
 */
export const messageAssignmentSchema = z
  .object({
    conversationId: z.string().nullable().describe("Existing conversation ID, or null to create a new one"),
    isPrimary: z.boolean().describe("True for exactly one assignment per call; the rest are secondaries"),
  })
  .strict()

export const reassignmentSchema = z
  .object({
    messageId: z.string().describe("ID of a message from the prompt's Recent Messages or Active Conversations"),
    toConversationId: z
      .string()
      .nullable()
      .describe("Target conversation, or null to move into the new conversation being created this turn"),
    reason: z.string().describe("One-line rationale for the move"),
    confidence: z.number().min(0).max(1).nullable().describe("Confidence in this specific reassignment, or null"),
  })
  .strict()

export const extractionResponseSchema = z.object({
  assignments: z.array(messageAssignmentSchema).min(1).describe("≥1 assignment, exactly one with isPrimary=true"),
  newConversationTopic: z
    .string()
    .nullable()
    .describe("Topic summary; required when any assignment has conversationId=null"),
  reassignments: z.array(reassignmentSchema).nullable().describe("Prior messages to move, or null"),
  completenessUpdates: z
    .array(
      z
        .object({
          conversationId: z.string(),
          score: z.number().min(1).max(7).describe("Completeness score: 1 = just started, 7 = fully resolved"),
          status: z
            .enum(CONVERSATION_STATUSES)
            .describe(`Conversation status: ${CONVERSATION_STATUSES.map((s) => `"${s}"`).join(" | ")}`),
        })
        .strict()
    )
    .nullable()
    .describe("Updates to completeness scores for affected conversations, or null if none"),
  confidence: z.number().min(0).max(1).describe("Overall confidence in this classification (0.0 to 1.0)"),
  reasoning: z.string().nullable().describe("Brief explanation of the classification decision"),
})

export type ExtractionResponse = z.infer<typeof extractionResponseSchema>
