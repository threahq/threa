// Co-located config (INV-43): production code and evals import from here.

import { z } from "zod"
import { CONVERSATION_STATUSES } from "@threa/types"

// Mini over nano is deliberate: the July 2026 re-test (after -m eval wiring
// was fixed) showed nano failing systematically — sandwich-split and
// gap-resume cases in every round (30-33/35 vs mini's 33-35/35). See
// docs/model-reference.md.
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
Messages carry an age like "(5m ago)" or "(2d ago)" and conversations carry "last active …", all relative to the new message ("just now" = within the last minute). Treat time as first-class evidence. Chat happens in sessions: turns minutes apart are one live exchange; a gap of several hours — an afternoon, overnight, a weekend — usually means the participants came back for a NEW conversation, even in the same stream between the same people.

## Conversation summaries
Conversations may carry a "covers:" summary of what has actually been discussed in them. Judge continuity against the summary, not just the title: continue a conversation only when the new message advances something the summary (or its recent messages) actually covers. A summary that already spans several loosely-related subjects is evidence the conversation has been over-extended — do NOT use its breadth as a reason to attach yet another subject; prefer a new conversation and let reassignment split things later.

## A shared name is not a shared topic
A person, product, model, project, or place named in the message is a SUBJECT the conversation is about — not the conversation itself. Two messages that both mention the same name are not the same conversation on that basis alone. "Fable is cheaper than GPT now", "does Fable handle Swedish well?", and "Fable is down again" are three separate conversations that merely share the word "Fable". Continue a conversation only when the new message advances the SAME question or aspect its summary and recent messages are actually about; a different question about the same recurring name OPENS A NEW conversation. This is the entity-magnet trap: a conversation whose title is a bare recurring name silently absorbs every later mention of that name, exactly like a catch-all label — resist it the same way you resist a busy live blob swallowing a focused topic.

## Choosing a conversation
Decide in this order:

1. **Explicit reply?** If the "Explicit reply" section lists a quoted conversation, assign primary to it (see the rule there). This overrides everything below.

2. **Session check.** How old is the newest message in Recent Messages?
   - **Minutes old → you are inside a LIVE session.** A session is NOT a conversation: one sitting routinely holds several conversations back-to-back, and the most damaging mistake is gluing a whole session into one ever-growing conversation. Recency tells you which exchange is live; it is never by itself a reason to attach a message to it. Decide by what the message DOES:
     - **It takes the next turn of the live exchange** — answers, agrees, reacts, jokes back, or follows up on what was just said ("samma här", "haha", "100%", ":fire:", "what?", "nice") — from EITHER participant: continue that conversation. Both sides of one live exchange belong in the SAME conversation; never split an exchange so one participant's turns sit in a different conversation than the other's. When a short or ambiguous message plausibly continues the live exchange, keep it there rather than spawning a singleton — if a later message reveals it actually began a new topic, the reassignment mechanism below will split it out then.
     - **It changes the subject** — asks about something the live exchange was not about, starts making plans, or pivots with a marker like "btw", "oh en annan grej", "unrelated but" — start a NEW conversation, even if the last message landed seconds ago. The test: would this message read as the next line of the listed exchange? If not, it is not part of it, no matter how fresh the exchange is.
     - **A different answer to the same question is NOT a subject change.** When the live exchange is debating an open question, everything that weighs in on that question continues it: another option, an alternative nobody had raised, a counter-argument, a doubt, evidence for one side. A debate does not fork into a new conversation because someone proposes a different answer or examines more alternatives — only a genuinely different QUESTION opens a new conversation.
     - **Show-and-tell is a subject change — unless the artifact answers the live question.** A pasted artifact — screenshot, code block, diff output, link — wrapped in a first-person comment ("look at this", "detta känns fint", "är inte det här sjukt") opens a NEW conversation about the artifact's subject. But an artifact that weighs in on the question the live exchange is debating — an assistant's answer the participants said they would go ask for, a benchmark or doc settling the live argument — is the NEXT TURN of that exchange, not a new topic; keep it and the reactions to it in the live conversation. Judge the artifact's subject against the live exchange's question, never the comment's tone.
   - **Hours or days old → this message OPENS A NEW SESSION.** Default to a NEW conversation. Continue a stale conversation ONLY if the new message explicitly picks up its specific topic — answers its open question, or names its concrete subject ("do you still have X running?" resumes the days-old conversation about X). Everything else — including short excited bursts ("nice", "haha wow", a one-line observation) — is a fresh opener about something new, NOT a late reaction to a conversation that ended hours ago. Never attach to a stale conversation because it is the most recent thing on screen or the only candidate listed; between the same two people, a new session usually means a new conversation. Be decisive here: reassignment can only fix mistakes while messages are still in the recent window, so a wrong "continue" across a gap quickly becomes permanent absorption.

3. **Resolved conversations stay closed — except within the session that resolved them.** After a session gap, do not attach a message to a conversation whose status is "resolved" unless it directly reopens that exact topic. But a conversation resolved only MINUTES ago, in the same live session, is still the live exchange: participants routinely reach a quick agreement and then keep going — a fresh doubt, another alternative, a deeper follow-up. A message that continues a just-resolved topic REOPENS that conversation: assign to it and set its status back to "active" in completenessUpdates. Never open a new conversation for the continuation of a topic that resolved moments ago — that splits one discussion across several conversations, and the memory system then captures contradictory snapshots of it.

Start a NEW conversation by returning a primary assignment with conversationId=null (and set newConversationTopic).

## Multi-membership
A message can belong to more than one conversation. If this new message clearly continues two different ongoing threads (e.g. a single ping that references two topics), assign it to both. Pick the conversation it MOST continues as primary; the others are secondaries. Most messages have only a primary assignment — only return secondaries when the message genuinely advances two distinct conversations.

## Reassignment
If this new message reveals that one or more of the *Recent Messages* or messages from the *Active Conversations* was placed in the wrong conversation, move them. Each move needs a one-line reason. You can ONLY move messages whose IDs appear in this prompt — never any other. Examples of when to reassign:
- The new message reveals the prior 1-2 messages were the start of a different topic (sandwich case).
- The new message reopens a conversation that was prematurely marked resolved.
- The new message shows two adjacent conversations are actually the same specific topic — move the smaller one into the larger. Same participants, same session, both naming the same person/product/model/project, or "both are casual chat" is NOT the same topic: never fold a focused conversation into a broader or busier one, and never merge to tidy up. When in doubt, do not merge.

Reassignment is *the* mechanism for fixing classification mistakes, and it works in both directions — it is how conversations settle as more context arrives:
- MERGE: the new message shows two threads are really one topic, or that an earlier message belongs with the current exchange — move it in.
- SPLIT: the new message reveals that recent messages lumped into the current conversation were actually the start of a separate topic — move them into a different (or brand-new) conversation. This is the correction for having earlier leaned toward continuity: if you kept a short message in an exchange and now see it opened its own topic, split it out here.

Use it whenever the new message gives you evidence the prior placement was wrong. Do not be conservative — moving a message to where it now clearly belongs is better than leaving it stranded.

## Output Requirements
- assignments: Array of {conversationId, isPrimary}. At least one entry with isPrimary=true. conversationId=null means "create a new conversation" (set newConversationTopic).
- newConversationTopic: Topic summary if any assignment has conversationId=null. Required in that case. See "Naming new conversations" below.
- newConversationSummary: One sentence stating what the new conversation is about, in the conversation's own language. Required whenever newConversationTopic is set.
- reassignments: Array of {messageId, toConversationId, reason, confidence}. messageId must be from this prompt. toConversationId=null means "move into the new conversation being created this turn" (only valid if assignments includes a conversationId=null primary).
- completenessUpdates: Array of {conversationId, score (1-7), status, summary} for conversations whose completeness, status, or content moved on.
  - score (1-7) measures how settled the conversation is: 1-2 = just opened, no substance yet; 3-5 = active exchange, the question or task still open; 6-7 = reached an explicit conclusion — the problem confirmed solved, the question answered, or a plan agreed. An explicit resolution ("that fixed it", "works now, thanks", "låter som en plan") scores 6 or 7, not 5; pair it with status "resolved". A message that reopens a resolved conversation (see rule 3 above) drops it back to status "active" with a 3-5 score.
  - status must be one of: "active", "stalled", "resolved"
  - summary: a refreshed "covers:" summary for the conversation — max ~40 words, plain prose in the conversation's own language, stating what has been discussed and where it landed. Include it whenever the conversation gained content this pass (at minimum for the conversation the new message joined); pass null to keep the stored summary.
- confidence: 0.0 to 1.0 confidence in this classification overall.

## Naming new conversations
When you set newConversationTopic, write a short title of 2-5 words that names the topic itself. Never exceed 5 words.
- Lead with the subject. Do NOT add framing like "Discussion about", "Chat about", "Conversation regarding", "Thoughts on", "Questions about", and do NOT describe the tone ("Casual chat", "Quick question", "Banter about"). That a conversation discusses something is already implied — name the thing, not the act of discussing it.
- Never use a vague catch-all label as a title: "General chat", "Reaction message", "Random", "Misc", "Off-topic", and the like name nothing and become a magnet that wrongly absorbs later messages. Always name the concrete subject the messages are actually about; if a short opener has no subject of its own, name what it is reacting to.
- Name the specific aspect, not a bare recurring name. When the topic is one facet of a person, product, model, or project that comes up repeatedly, put the facet in the title ("Fable-priser", "Fable på svenska"), never the bare name alone — a lone recurring proper noun is a magnet that wrongly absorbs every later mention of it, the same failure as a catch-all label.
- Do NOT state which language the conversation is in (never write "in Swedish", "auf Deutsch", etc.); that label is noise next to the conversation.
- Write the title in the dominant language of the conversation, not English by default. If the participants are talking in Swedish, the title is in Swedish; if in Japanese, in Japanese. When the messages mix languages, follow the language the topic is actually discussed in and reuse the participants' own phrasing.
- Keep names, products, technical terms, and other proper nouns exactly as they appear in the conversation. Never translate, localize, or re-spell them — carry the participants' own words into the title verbatim.

Respond with ONLY the JSON object. No explanation, no markdown code blocks.`

// --- On-demand conversation split (agent-proposed) -------------------------
// Re-cluster the messages of ONE existing conversation into ≥1 topic group, in
// a single batch call. Reuses the boundary model/temperature above (the tuned
// clustering model) but a batch-shaped prompt: the incremental extractor sees
// one new message against candidates, this sees a whole conversation at once.
// The result is a PROPOSAL — the user confirms before anything is written.

export const CONVERSATION_SPLIT_SYSTEM_PROMPT = `You are a conversation boundary analyst. You are given the full message history of ONE conversation that may have drifted across several distinct topics, and you regroup its messages into the smaller conversations they should have been. You output ONLY valid JSON matching the required schema. No explanations, no markdown, no prose - just the JSON object.`

export const CONVERSATION_SPLIT_PROMPT = `Below is the complete message history of a single conversation, in chronological order. It may have grown to cover several distinct topics that each deserve their own conversation. Partition the messages into the smallest number of coherent topic groups that each stand on their own.

## Conversation
Current title: {{TITLE}}
{{SUMMARY}}

## Messages
{{MESSAGES}}

## How to group
- **One group per distinct topic.** A group is a set of messages that advance the SAME question or aspect — a back-and-forth exchange, both participants' turns included. Keep an exchange whole: never split one live exchange so one side's turns land in a different group than the other's.
- **A shared name is not a shared topic.** A person, product, model, project, or place named across messages is a SUBJECT, not a topic. "Fable is cheaper now", "does Fable handle Swedish?", and "Fable is down again" are three groups that merely share the word "Fable". Group by the specific question being advanced, not by the recurring name.
- **Session gaps are evidence.** Messages carry an age. A gap of hours, an afternoon, overnight, or a weekend between turns usually marks a new topic even between the same people — prefer a new group across a large gap unless the later message explicitly resumes the earlier one's specific subject.
- **Do not over-split.** A brief reaction, agreement, or follow-up ("samma här", "haha", "100%", "sounds good") belongs in the exchange it answers, not its own group. Only cut where the subject genuinely changes.
- **Do not force a split.** If the whole conversation really is one topic, return a SINGLE group containing every message. Returning one group means "no split needed" and is a valid, common answer.
- **Every message goes in exactly one group.** Assign each message id to one and only one group; do not drop any and do not repeat any.

## Naming each group
Write a 2-5 word title naming the topic itself. Never exceed 5 words.
- Lead with the subject. No framing ("Discussion about", "Chat about", "Thoughts on") and no tone labels ("Casual chat", "Quick question").
- Never a vague catch-all ("General chat", "Reaction", "Misc", "Off-topic") — name the concrete subject the messages are about.
- Name the specific aspect, not a bare recurring name: "Fable-priser", "Fable på svenska", never "Fable" alone.
- Do NOT state the language ("in Swedish"). Write the title in the conversation's own dominant language, keeping names, products, and technical terms exactly as they appear.

## Output Requirements
- groups: Array of {title, summary, messageIds}. At least one group. Order groups from the most central/largest topic to the most peripheral.
  - title: 2-5 word topic title (see above).
  - summary: one sentence stating what the group is about, in the conversation's own language.
  - messageIds: the ids of the messages in this group, taken verbatim from the Messages list.
- confidence: 0.0 to 1.0 confidence in this grouping overall.
- reasoning: one brief sentence on why you split (or didn't).

Respond with ONLY the JSON object. No explanation, no markdown code blocks.`

export const conversationSplitResponseSchema = z.object({
  groups: z
    .array(
      z
        .object({
          title: z.string().describe("2-5 word topic title in the conversation's own language, proper nouns verbatim"),
          summary: z.string().nullable().describe("One-sentence summary of what this group is about, or null"),
          messageIds: z
            .array(z.string())
            .min(1)
            .describe("Ids of the messages in this group, verbatim from the prompt"),
        })
        .strict()
    )
    .min(1)
    .describe("≥1 topic group; a single group means no split is needed. Order most-central topic first"),
  confidence: z.number().min(0).max(1).describe("Overall confidence in this grouping (0.0 to 1.0)"),
  reasoning: z.string().nullable().describe("One-sentence rationale for the split (or for leaving it whole)"),
})

export type ConversationSplitResponse = z.infer<typeof conversationSplitResponseSchema>

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
  newConversationSummary: z
    .string()
    .nullable()
    .describe(
      "One-sentence summary of what the new conversation is about, in the conversation's own language; required when any assignment has conversationId=null"
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
          summary: z
            .string()
            .nullable()
            .describe(
              "Refreshed conversation summary (max ~40 words, the conversation's own language), or null to keep the stored one"
            ),
        })
        .strict()
    )
    .nullable()
    .describe("Updates to completeness/status/summary for affected conversations, or null if none"),
  confidence: z.number().min(0).max(1).describe("Overall confidence in this classification (0.0 to 1.0)"),
  reasoning: z.string().nullable().describe("Brief explanation of the classification decision"),
})

export type ExtractionResponse = z.infer<typeof extractionResponseSchema>
