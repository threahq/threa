import { createHash } from "node:crypto"
import type { Message } from "../messaging"
import type { Conversation } from "../conversations"
import type { Memo } from "./repository"

/**
 * A digest of everything the memo classifier is shown for a conversation.
 *
 * Two passes with the same fingerprint would put an identical question to the
 * model, so the second can be skipped. The accumulator re-queues a conversation
 * on every `conversation:updated` — including completeness and summary changes
 * that carry no new content — so a share of classify calls re-ask a question
 * already answered.
 *
 * It hashes the *inputs* that determine the prompt, never the rendered prompt.
 * The transcript is rendered with relative ages against `new Date()` at batch
 * time, so its text differs on every pass even when nothing happened; hashing
 * it would mean the fingerprint never matches and the gate never fires.
 *
 * Deliberately included, each because it can flip the classifier's answer
 * without any message changing:
 * - `status` — a resolve or reopen changes whether the conversation reads as
 *   settled knowledge.
 * - `topicSummary` and `participantIds` — both are rendered into the prompt.
 * - each message's `editedAt` / `deletedAt` — an edit rewrites the transcript
 *   while leaving the id list identical.
 * - each existing memo's `version` — the classifier is asked
 *   `shouldReviseExisting` against these; a memo edited or superseded elsewhere
 *   changes the correct answer even though the conversation stands still.
 */
export function classificationFingerprint(
  conversation: Pick<Conversation, "status" | "topicSummary" | "participantIds" | "messageIds">,
  messages: Message[],
  existingMemos: Memo[]
): string {
  const messageById = new Map(messages.map((m) => [m.id, m]))

  const parts = [
    `status:${conversation.status}`,
    `topic:${conversation.topicSummary ?? ""}`,
    `participants:${[...conversation.participantIds].sort().join(",")}`,
    ...conversation.messageIds.map((id) => {
      const message = messageById.get(id)
      // A message the batch could not load is still a change of input if it
      // later appears, so it hashes distinctly from a loaded one.
      if (!message) return `m:${id}:missing`
      return `m:${id}:${message.editedAt?.getTime() ?? 0}:${message.deletedAt?.getTime() ?? 0}`
    }),
    ...[...existingMemos].map((memo) => `memo:${memo.id}:${memo.version}`).sort(),
  ]

  return createHash("sha256").update(parts.join("\n")).digest("hex")
}
