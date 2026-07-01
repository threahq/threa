// Co-located config (INV-43): production code and evals import from here.

import { z } from "zod"
import { CONVERSATION_STATUSES } from "@threa/types"

export const BOUNDARY_EXTRACTION_MODEL_ID = "openrouter:openai/gpt-5.4-mini"

/** Low temperature for classification consistency. */
export const BOUNDARY_EXTRACTION_TEMPERATURE = 0.2

/**
 * Per-attachment character budget when rendering extracted text in the prompt.
 * The new message's attachments get a bigger window because they are the
 * payload most likely to change the classification decision; context messages
 * use a smaller window (closer to a summary) to keep the prompt bounded.
 */
export const NEW_MESSAGE_ATTACHMENT_CHARS = 2000
export const RECENT_ATTACHMENT_CHARS = 400

export const BOUNDARY_EXTRACTION_SYSTEM_PROMPT = `You are a conversation boundary classifier. You analyze messages and output ONLY valid JSON matching the required schema. No explanations, no markdown, no prose - just the JSON object.`

export const BOUNDARY_EXTRACTION_PROMPT = `Analyze this new message and decide which conversation(s) it belongs to. You may also move recent messages that were placed in the wrong conversation, now that this new message clarifies what was happening.

## Active Conversations
{{CONVERSATIONS}}

## Recent Messages
{{RECENT_MESSAGES}}

## New Message
From: {{AUTHOR}}
Content: {{CONTENT}}

## Explicit reply
{{REPLY_CONTEXT}}

When the new message explicitly quote-replies an earlier message, that is a deliberate user action and the STRONGEST available signal of continuity — it OVERRIDES every other signal, including recency and whatever exchange is currently live. When this section lists a quoted conversation, assign the new message (as primary) to that conversation, even if a different conversation owns all the most recent messages. Override this only when the new message's own words explicitly open a different subject while quoting ("unrelated, but…"). A reply that merely reacts, agrees, asks a follow-up, or builds on the quoted message ("samma här", "kör på det", "sounds good") ALWAYS stays in the quoted message's conversation — brevity is not a reason to leave it in the live exchange. The quoted message's conversation is listed in Active Conversations above, so you can always assign to it.

## Attachments
Some messages above may include an indented \`[attachment <filename> (<kind>)]:\` block beneath them. That block is the extracted text of the attachment — the transcript for audio/video, OCR text for an image, the parsed body for a PDF/Word/Excel, etc. Treat that extracted text as **part of the message's content** when judging topic continuity: a voice memo whose transcript is about onboarding is an onboarding message even if its written content is empty. Pay particular attention to the new message's attachments, since a short or empty written body is often a wrapper around the real payload that lives in the attachment.

## Time
Messages carry an age like "(5m ago)" or "(2d ago)" and conversations carry "last active …", all relative to the new message ("just now" = within the last minute). Treat time as first-class evidence. Chat happens in sessions: turns minutes apart are one live exchange; a gap of many hours — overnight, a day, a weekend — usually means the participants came back for a NEW conversation, even in the same stream between the same people.

## Choosing a conversation
First decide whether this message continues an existing conversation or starts a new one. Judge by:
- Explicit references: does it quote, reply to, or build on something in a conversation? (See "Explicit reply" above — a quote-reply is decisive.)
- Topic continuity: does it advance the same subject the conversation is about? Use the attachment-extracted text as content here too.
- Recency and flow: does it read as the next turn of a LIVE back-and-forth? Check the ages — an exchange is only live when its last turns are minutes old, not hours.

Within a live exchange, prefer continuing it. Conversation is a back-and-forth between participants: a short reply, agreement, reaction, joke, or follow-up from EITHER participant ("samma här", "haha", "100%", ":fire:", "what?", "nice") continues the current exchange — it does not start its own conversation, and which participant sent it is irrelevant. Both sides of one live exchange belong in the SAME conversation; never split an exchange so one participant's turns sit in a different conversation than the other's. When a short or ambiguous message plausibly continues the live exchange, keep it there rather than spawning a singleton — if a later message reveals it actually began a new topic, the reassignment mechanism below will split it out then.

After a gap, the default flips. When many hours or days have passed since a conversation's last activity, that conversation is over unless the new message explicitly picks its specific topic back up — answers its open question, quote-replies into it, or clearly resumes the same concrete subject ("do you still have X running?" resumes the days-old conversation about X). A message that opens with something new after a quiet period starts a NEW conversation, even when a stale conversation is the most recent thing on screen, even between the same participants, and even when that conversation was never marked resolved. Never attach to a stale conversation just because it is the only candidate listed — creating a new conversation is always available and is the correct default after a gap. Be decisive at session boundaries: reassignment can only fix mistakes while messages are still in the recent window, so a wrong "continue" across a gap quickly becomes permanent absorption.

Start a NEW conversation (primary assignment with conversationId=null) when the message opens a topic no active conversation covers — a distinct new question, subject, or unrelated aside that does not read as the next turn of any listed exchange — or when it opens a new session after a gap, as described above. Do not attach a message to a conversation whose status is "resolved" unless it directly reopens that exact topic.

## Multi-membership
A message can belong to more than one conversation. If this new message clearly continues two different ongoing threads (e.g. a single ping that references two topics), assign it to both. Pick the conversation it MOST continues as primary; the others are secondaries. Most messages have only a primary assignment — only return secondaries when the message genuinely advances two distinct conversations.

## Reassignment
If this new message reveals that one or more of the *Recent Messages* or messages from the *Active Conversations* was placed in the wrong conversation, move them. Each move needs a one-line reason. You can ONLY move messages whose IDs appear in this prompt — never any other. Examples of when to reassign:
- The new message reveals the prior 1-2 messages were the start of a different topic (sandwich case).
- The new message reopens a conversation that was prematurely marked resolved.
- The new message shows two adjacent conversations are actually the same topic — move the smaller one into the larger.

Reassignment is *the* mechanism for fixing classification mistakes, and it works in both directions — it is how conversations settle as more context arrives:
- MERGE: the new message shows two threads are really one topic, or that an earlier message belongs with the current exchange — move it in.
- SPLIT: the new message reveals that recent messages lumped into the current conversation were actually the start of a separate topic — move them into a different (or brand-new) conversation. This is the correction for having earlier leaned toward continuity: if you kept a short message in an exchange and now see it opened its own topic, split it out here.

Use it whenever the new message gives you evidence the prior placement was wrong. Do not be conservative — moving a message to where it now clearly belongs is better than leaving it stranded.

## Output Requirements
- assignments: Array of {conversationId, isPrimary}. At least one entry with isPrimary=true. conversationId=null means "create a new conversation" (set newConversationTopic).
- newConversationTopic: Topic summary if any assignment has conversationId=null. Required in that case. See "Naming new conversations" below.
- reassignments: Array of {messageId, toConversationId, reason, confidence}. messageId must be from this prompt. toConversationId=null means "move into the new conversation being created this turn" (only valid if assignments includes a conversationId=null primary).
- completenessUpdates: Array of {conversationId, score (1-7), status} for conversations whose completeness changed.
  - status must be one of: "active", "stalled", "resolved"
- confidence: 0.0 to 1.0 confidence in this classification overall.

## Naming new conversations
When you set newConversationTopic, write a short title of 2-5 words that names the topic itself. Never exceed 5 words.
- Lead with the subject. Do NOT add framing like "Discussion about", "Chat about", "Conversation regarding", "Thoughts on", "Questions about", and do NOT describe the tone ("Casual chat", "Quick question", "Banter about"). That a conversation discusses something is already implied — name the thing, not the act of discussing it.
- Never use a vague catch-all label as a title: "General chat", "Reaction message", "Random", "Misc", "Off-topic", and the like name nothing and become a magnet that wrongly absorbs later messages. Always name the concrete subject the messages are actually about; if a short opener has no subject of its own, name what it is reacting to.
- Do NOT state which language the conversation is in (never write "in Swedish", "auf Deutsch", etc.); that label is noise next to the conversation.
- Write the title in the dominant language of the conversation, not English by default. If the participants are talking in Swedish, the title is in Swedish; if in Japanese, in Japanese. When the messages mix languages, follow the language the topic is actually discussed in and reuse the participants' own phrasing.
- Keep names, products, technical terms, and other proper nouns exactly as they appear in the conversation. Never translate, localize, or re-spell them — carry the participants' own words into the title verbatim.

Respond with ONLY the JSON object. No explanation, no markdown code blocks.`

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
    .describe(
      "2-5 word topic title; required when any assignment has conversationId=null. Name the topic directly with no framing ('Discussion about'), no language label ('in Swedish'), in the conversation's own language, keeping proper nouns verbatim"
    ),
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
