import type { AuthorType, JSONContent } from "@threa/types"
import { AuthorTypes } from "@threa/types"

export interface NormalizedMessagePayload {
  workspaceId: string
  streamId: string
  event: {
    id: string
    sequence: string
    actorType: AuthorType
    actorId: string | null
    payload: {
      messageId: string
      contentMarkdown: string
      /**
       * Canonical ProseMirror content (INV-58). Null only when the event
       * payload predates contentJson or is malformed — consumers that read
       * structural nodes (mentions, shares) treat null as "none present".
       */
      contentJson: JSONContent | null
      /** Server-derived and caller metadata; empty when the message carries none. */
      metadata: Record<string, string>
    }
  }
}

/** Returns null if minimum required fields cannot be extracted. */
export function parseMessagePayload(payload: unknown): NormalizedMessagePayload | null {
  if (!payload || typeof payload !== "object") {
    return null
  }

  const p = payload as Record<string, unknown>

  if (typeof p.workspaceId !== "string" || typeof p.streamId !== "string") {
    return null
  }

  const event = p.event as Record<string, unknown> | undefined

  if (event && typeof event === "object") {
    const eventPayload = event.payload as Record<string, unknown> | undefined

    if (eventPayload && typeof eventPayload === "object" && typeof eventPayload.messageId === "string") {
      return {
        workspaceId: p.workspaceId,
        streamId: p.streamId,
        event: {
          id: (event.id as string) ?? "",
          sequence: (event.sequence as string) ?? "0",
          actorType: (event.actorType as AuthorType) ?? AuthorTypes.USER,
          actorId: (event.actorId as string | null) ?? null,
          payload: {
            messageId: eventPayload.messageId,
            contentMarkdown: (eventPayload.contentMarkdown as string) ?? "",
            contentJson:
              eventPayload.contentJson &&
              typeof eventPayload.contentJson === "object" &&
              !Array.isArray(eventPayload.contentJson)
                ? (eventPayload.contentJson as JSONContent)
                : null,
            metadata:
              eventPayload.metadata &&
              typeof eventPayload.metadata === "object" &&
              !Array.isArray(eventPayload.metadata)
                ? (eventPayload.metadata as Record<string, string>)
                : {},
          },
        },
      }
    }
  }

  return null
}
