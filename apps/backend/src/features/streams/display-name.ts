import type { Stream, StreamType } from "./repository"

export type DisplayNameSource = "slug" | "generated" | "participants" | "placeholder"

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

    case "thread":
      if (stream.displayName && stream.displayNameGeneratedAt) {
        return {
          displayName: stream.displayName,
          source: "generated",
        }
      }
      if (context?.parentStream) {
        const parentName = context.parentStream.slug ?? context.parentStream.displayName ?? "channel"
        return {
          displayName: `Thread in #${parentName}`,
          source: "placeholder",
        }
      }
      return {
        displayName: "New thread",
        source: "placeholder",
      }

    case "scratchpad":
      if (stream.displayName && stream.displayNameGeneratedAt) {
        return {
          displayName: stream.displayName,
          source: "generated",
        }
      }
      return {
        displayName: "New scratchpad",
        source: "placeholder",
      }

    default:
      return {
        displayName: stream.displayName ?? "Unnamed",
        source: stream.displayNameGeneratedAt ? "generated" : "placeholder",
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

/** True only for scratchpads/threads that have no display name yet. */
export function needsAutoNaming(stream: Stream): boolean {
  if (stream.type !== "scratchpad" && stream.type !== "thread") {
    return false
  }
  return stream.displayName === null
}
