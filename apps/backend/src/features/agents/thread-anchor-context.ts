import type { Querier } from "../../db"
import type { AuthorType, JSONContent, CallStartedEventPayload, DelegationCreatedEventPayload } from "@threa/types"
import { MessageRepository, type Message } from "../messaging"
import { StreamEventRepository, type Stream } from "../streams"

/** Keep synthesized card context terse — the reply chain is the payload, the card is the frame. */
const MAX_BRIEF_CHARS = 800

function textDoc(text: string): JSONContent {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }
}

/** Render a threadable card event as the terse markdown the agent needs to know what the thread is about. */
function serializeCardAnchor(eventType: string, payload: unknown): string | null {
  if (eventType === "delegation:created") {
    const p = payload as DelegationCreatedEventPayload
    const brief = p.brief.length > MAX_BRIEF_CHARS ? `${p.brief.slice(0, MAX_BRIEF_CHARS)}…` : p.brief
    return `Delegation: ${p.title}\n\n${brief}`
  }
  if (eventType === "call_started") {
    const p = payload as CallStartedEventPayload
    return `Call started (${p.mode === "audio_only" ? "audio" : "video"})`
  }
  return null
}

/**
 * The thread's anchor rendered as a prompt-context `Message`, whichever kind it
 * is — the one anchor track (INV-2 prefix discriminates): a `msg_…` anchor is the
 * real spawning message (soft-delete filtered via {@link MessageRepository.findThreadRoot});
 * an `event_…` anchor is the threadable card (delegation/call) synthesized into a
 * message-shaped context so the agent in a delegation-result thread or call chat
 * knows the card's subject. Returns null for non-threads and cards with no
 * serializable frame.
 */
export async function findThreadAnchorContext(db: Querier, stream: Stream): Promise<Message | null> {
  const anchorId = stream.parentAnchorId ?? stream.parentMessageId
  if (!anchorId) return null
  if (anchorId.startsWith("msg_")) return MessageRepository.findThreadRoot(db, { parentMessageId: anchorId })

  const event = await StreamEventRepository.findById(db, anchorId)
  if (!event) return null
  const text = serializeCardAnchor(event.eventType, event.payload)
  if (!text) return null

  return {
    id: event.id,
    streamId: event.streamId,
    sequence: event.sequence,
    authorId: event.actorId ?? "",
    authorType: event.actorType ?? ("user" as AuthorType),
    contentJson: textDoc(text),
    contentMarkdown: text,
    replyCount: 0,
    clientMessageId: null,
    sentVia: null,
    reactions: {},
    metadata: {},
    conversationIntent: null,
    editedAt: null,
    deletedAt: null,
    createdAt: event.createdAt,
    ciphertext: null,
    envelope: null,
    e2eVersion: null,
  }
}
