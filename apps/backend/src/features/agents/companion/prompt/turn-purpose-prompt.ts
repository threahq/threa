import { StreamTypes, type AgentSessionRerunContext } from "@threa/types"
import { formatCurrentTime } from "../../../../lib/temporal"
import type { StreamContext } from "../../context-builder"
import type { TurnPurpose } from "../../turn-purpose"

/**
 * Per-purpose system-prompt sections. Each invocation kind self-describes why
 * the turn is running, mirroring how each tool carries its own `promptBlock`
 * (roadmap 1.5). One switch here is the single place a new kind adds its
 * prose — no scattered `if (trigger === …)` / `if (followUp)` branches.
 *
 * Two insertion points, both dispatched from the same purpose:
 * - "early" (mention, follow-up) — announces the invocation before the stream
 *   context, matching where these have always sat.
 * - "late" (supersede reconciliation) — appended after everything else so its
 *   final-decision directive is the most salient instruction.
 */

interface EarlyPurposeContext {
  context: StreamContext
  mentionerName?: string
  /** The note the fired follow-up carried; present only for a follow-up turn. */
  followUp?: { note: string; scheduledFor: Date } | null
}

export function buildEarlyPurposeSection(purpose: TurnPurpose, ctx: EarlyPurposeContext): string {
  switch (purpose.kind) {
    case "mention":
      return buildMentionSection(ctx.context, ctx.mentionerName)
    case "follow_up":
      return ctx.followUp ? buildFollowUpSection(ctx.context, ctx.followUp) : ""
    case "catch_up":
    case "supersede_rerun":
      return ""
  }
}

export function buildLatePurposeSection(purpose: TurnPurpose): string {
  return purpose.kind === "supersede_rerun" ? buildSupersedeSection(purpose.rerunContext) : ""
}

function buildMentionSection(context: StreamContext, mentionerName?: string): string {
  const mentionerDesc = mentionerName ? `**${mentionerName}**` : "a user"
  let section = `

## Invocation Context

You were explicitly @mentioned by ${mentionerDesc} who wants your assistance.`

  if (context.streamType === StreamTypes.CHANNEL) {
    section += ` This conversation is happening in a thread created specifically for your response.`
  }

  return section
}

function buildFollowUpSection(context: StreamContext, followUp: { note: string; scheduledFor: Date }): string {
  const scheduledForDisplay = context.temporal
    ? formatCurrentTime(followUp.scheduledFor, context.temporal.timezone, context.temporal.dateFormat, context.temporal.timeFormat)
    : followUp.scheduledFor.toISOString()

  return `

## Scheduled follow-up firing now

This turn is a follow-up you scheduled for yourself — not a new message from anyone. You are waking up on your own timer to revisit this stream.

- You set this reminder (at ${scheduledForDisplay}) to: "${followUp.note.trim()}"
- This IS that reminder firing. Act on it now — look at what has happened in the stream since you scheduled it and, if there's something worth saying, post your check-in with \`send_message\`. Do not decline or promise to check back later; later is now.
- Do NOT schedule another follow-up for the same thing. The note above is what this turn is already handling — re-reading it as a fresh instruction and scheduling again just loops forever. Only schedule a new follow-up if genuinely new future work has surfaced.
- If nothing needs saying (the matter resolved itself, nothing changed, or you're still waiting on someone), call \`keep_response\` with a brief reason and stay silent. Do not post filler.`
}

function buildSupersedeSection(rerunContext?: AgentSessionRerunContext): string {
  const cause =
    rerunContext?.cause === "referenced_message_edited"
      ? "a follow-up (referenced) message was edited"
      : "the invoking message was edited"
  const editedBefore = rerunContext?.editedMessageBefore?.trim()
  const editedAfter = rerunContext?.editedMessageAfter?.trim()

  const changeBlock = [
    `Rerun cause: ${cause}.`,
    `Edited message ID: ${rerunContext?.editedMessageId ?? "unknown"}.`,
    editedBefore ? `Before edit: "${editedBefore}"` : null,
    editedAfter ? `After edit: "${editedAfter}"` : null,
    rerunContext?.editedMessageRevision ? `Edited message revision: ${rerunContext.editedMessageRevision}.` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n")

  return `

## Superseded Session Reconciliation

This run supersedes a previous completed session because conversation context changed after completion.
${changeBlock}

For the final outcome:
- Compare the previous response(s) against the edited context and current conversation state.
- Treat the edited message text as the authoritative user intent. The prior wording is obsolete.
- If any previous response is now incorrect, contradictory, or misses a new constraint, call \`send_message\` with the revised response.
- When updating, answer the edited request directly with concrete help. Do not ask the user to reconfirm the edited intent unless the edited prompt is genuinely ambiguous or missing required constraints.
- For "best" or singular requests, provide one clear recommendation first (with practical details), then optional alternatives.
- If the edited request is concrete (for example noun/topic substitutions), do not reply with only a clarification question.
- Avoid meta narration about the edit itself (for example "I see your message was edited") unless the user explicitly asks about that process.
- If the previous response should stay exactly as-is, call \`keep_response\` with a specific reason that references what changed and why no update is needed.
- Never use both \`keep_response\` and \`send_message\` for the same final decision.
- Do not end your turn without calling exactly one of \`keep_response\` or \`send_message\`.`
}
