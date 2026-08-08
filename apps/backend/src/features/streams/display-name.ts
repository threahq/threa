import type { Stream, StreamType } from "./repository"

export type DisplayNameSource = "slug" | "generated" | "explicit" | "legacy" | "participants" | "placeholder"

/** A stored name is authoritative; provenance controls whether naming may replace it. */
function storedDisplayName(stream: Stream): EffectiveDisplayName | undefined {
  // Whitespace is not a name: rendering it gives a blank row, and
  // `needsAutoNaming` would still count the stream as named, so nothing would
  // ever replace it.
  const name = stream.displayName?.trim()
  if (!name) return undefined
  return { displayName: name, source: stream.displayNameSource ?? "legacy" }
}

export interface DisplayNameContext {
  parentStream?: { slug: string | null; displayName: string | null } | null
  participants?: { id: string; name: string }[]
  viewingUserId?: string
}

export interface EffectiveDisplayName {
  displayName: string
  source: DisplayNameSource
}

/** Computes the effective display name for a stream based on its type. */
export function getEffectiveDisplayName(stream: Stream, context?: DisplayNameContext): EffectiveDisplayName {
  switch (stream.type) {
    case "channel":
      return {
        displayName: stream.slug ?? "unnamed-channel",
        source: "slug",
      }

    case "dm":
      if (context?.participants && context.viewingUserId) {
        return {
          displayName: formatParticipantNames(context.participants, context.viewingUserId),
          source: "participants",
        }
      }
      return {
        displayName: "Direct message",
        source: "placeholder",
      }

    case "thread": {
      const stored = storedDisplayName(stream)
      if (stored) return stored
      if (context?.parentStream) {
        // The # sigil is a channel affordance — a slugless parent (scratchpad,
        // DM) must not render as a phantom "#channel".
        if (context.parentStream.slug) {
          return { displayName: `Thread in #${context.parentStream.slug}`, source: "placeholder" }
        }
        if (context.parentStream.displayName) {
          return { displayName: `Thread in ${context.parentStream.displayName}`, source: "placeholder" }
        }
        return { displayName: "Thread", source: "placeholder" }
      }
      return {
        displayName: "New thread",
        source: "placeholder",
      }
    }

    case "scratchpad":
      return storedDisplayName(stream) ?? { displayName: "New scratchpad", source: "placeholder" }

    default:
      return {
        displayName: stream.displayName ?? "Unnamed",
        source: stream.displayName ? (stream.displayNameSource ?? "legacy") : "placeholder",
      }
  }
}

/**
 * Formats participant names for DM display.
 * DMs are strict 1:1, so the effective name is always "the other participant".
 */
export function formatParticipantNames(participants: { id: string; name: string }[], viewingUserId: string): string {
  const other = participants.find((participant) => participant.id !== viewingUserId)
  if (other) {
    return other.name
  }

  // Defensive fallback for inconsistent data.
  return participants[0]?.name ?? "Direct message"
}
