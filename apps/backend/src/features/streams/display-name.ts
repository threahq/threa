import type { Stream, StreamType } from "./repository"

export type DisplayNameSource = "slug" | "generated" | "explicit" | "participants" | "placeholder"

/**
 * A stored name is authoritative however it got there.
 *
 * `display_name_generated_at` records that the auto-namer wrote the name; it is
 * never set by `StreamRepository.insert`, so requiring it to render meant every
 * scratchpad created WITH a name — which is what every bot runtime does — was
 * displayed as "New scratchpad" forever. `needsAutoNaming` keys off
 * `displayName === null`, so those streams were also skipped by the very
 * namer that would have set the timestamp: named enough to be ineligible,
 * ungenerated enough to be invisible.
 */
function storedDisplayName(stream: Stream): EffectiveDisplayName | undefined {
  if (!stream.displayName) return undefined
  return { displayName: stream.displayName, source: stream.displayNameGeneratedAt ? "generated" : "explicit" }
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
