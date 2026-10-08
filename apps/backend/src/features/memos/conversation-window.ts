import type { Message } from "../messaging"

export interface ConversationWindow {
  /** Oldest first. */
  messages: Message[]
  /** Newest activity this window read; carried forward unchanged when nothing new was read. */
  readThrough: Date | null
  /** False when unread messages remain past this window, so another pass must follow. */
  complete: boolean
}

const activityAt = (message: Message): number => Math.max(message.createdAt.getTime(), message.editedAt?.getTime() ?? 0)

const size = (message: Message): number => message.contentMarkdown.length

const byCreation = (a: Message, b: Message): number =>
  a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)

/**
 * The part of a conversation one memo pass reads. A conversation that fits
 * `maxChars` is read whole. A longer one reads what was posted or edited after
 * `readThrough`, oldest first, then tops up with the newest earlier messages
 * as context. Unread messages that don't fit are left for the next pass.
 *
 * Activity is compared at millisecond precision, the precision the driver
 * returns, so a cut never falls between messages sharing a millisecond.
 */
export function selectConversationWindow(
  messages: Message[],
  readThrough: Date | null,
  maxChars: number
): ConversationWindow {
  const totalChars = messages.reduce((sum, m) => sum + size(m), 0)
  if (totalChars <= maxChars) {
    const newest = messages.reduce((max, m) => Math.max(max, activityAt(m)), readThrough?.getTime() ?? -Infinity)
    return {
      messages: [...messages].sort(byCreation),
      readThrough: Number.isFinite(newest) ? new Date(newest) : null,
      complete: true,
    }
  }

  const since = readThrough?.getTime() ?? -Infinity
  const unread = messages.filter((m) => activityAt(m) > since).sort((a, b) => activityAt(a) - activityAt(b))
  const window: Message[] = []
  let used = 0
  for (const message of unread) {
    const previous = window.at(-1)
    if (previous && used + size(message) > maxChars && activityAt(message) !== activityAt(previous)) break
    window.push(message)
    used += size(message)
  }
  const last = window.at(-1)
  const complete = window.length === unread.length

  const alreadyRead = messages.filter((m) => activityAt(m) <= since).sort((a, b) => byCreation(b, a))
  for (const message of alreadyRead) {
    if (used + size(message) > maxChars) break
    window.push(message)
    used += size(message)
  }

  return {
    messages: window.sort(byCreation),
    readThrough: last ? new Date(activityAt(last)) : readThrough,
    complete,
  }
}
