/**
 * The one vocabulary for "where a draft came from". The Drafts explorer names a
 * draft's location for its rows and the composer's stash picker names it for
 * borrowed rows; both read the same phrases from here so the two surfaces can't
 * describe the same place two ways (INV-33/INV-35).
 *
 * Each helper takes the already-resolved place name (a stream label, a
 * conversation's topic summary) and returns the fallback phrasing when it is
 * null — an unresolved location never renders an id or a blank.
 */

export function threadOriginLabel(streamName: string | null): string {
  return streamName ? `Thread in ${streamName}` : "Thread reply"
}

export function conversationOriginLabel(target: string | null): string {
  return target ? `Reply in ${target}` : "Conversation reply"
}

export function subtopicOriginLabel(context: string | null): string {
  return context ? `New sub-topic in ${context}` : "New sub-topic"
}
