import type { Pool } from "pg"
import type { JSONContent, SharedMessageRef } from "@threa/types"
import {
  collectSharedMessageRefs,
  hydrateSharedMessageRefsForAccessibleSet,
  type HydratedSharedMessage,
} from "../messaging"
import type { WireSharedMessageSlot, WireSlotMap } from "./routes"

type OkSlot = Extract<WireSharedMessageSlot, { state: "ok" }>

/**
 * Serialize one hydrated shared-message slot to its public projection: the
 * `ok` variant exposes markdown as `content` and drops the canonical
 * `contentJson` (INV-58 — the rich-text JSON stays internal, markdown is the
 * external content authority); the other states pass through the same
 * privacy-safe placeholders the internal wire ships. Dates are ISO-encoded.
 */
function serializePublicSlot(slot: HydratedSharedMessage): WireSharedMessageSlot {
  switch (slot.state) {
    case "ok":
      return {
        type: "sharedMessage",
        state: "ok",
        messageId: slot.messageId,
        streamId: slot.streamId,
        authorId: slot.authorId,
        authorType: slot.authorType as OkSlot["authorType"],
        ...(slot.authorName != null && { authorDisplayName: slot.authorName }),
        content: slot.contentMarkdown,
        editedAt: slot.editedAt ? slot.editedAt.toISOString() : null,
        createdAt: slot.createdAt.toISOString(),
        attachments: slot.attachments,
      }
    case "deleted":
      return {
        type: "sharedMessage",
        state: "deleted",
        messageId: slot.messageId,
        deletedAt: slot.deletedAt.toISOString(),
      }
    case "missing":
      return { type: "sharedMessage", state: "missing", messageId: slot.messageId }
    case "private":
      return {
        type: "sharedMessage",
        state: "private",
        messageId: slot.messageId,
        sourceStreamKind: slot.sourceStreamKind,
        sourceVisibility: slot.sourceVisibility,
      }
    case "truncated":
      return { type: "sharedMessage", state: "truncated", messageId: slot.messageId, streamId: slot.streamId }
  }
}

/**
 * Resolve the response-level `slots` map for a page of public-API message
 * rows. Collects every shared-message pointer across all rows once (INV-56),
 * hydrates them against the key principal's accessible stream set (active +
 * archived for user keys; the bot's readable set for bot keys) plus share
 * grants into those streams, and serializes to the markdown-only public
 * projection keyed by canonical `shared:<messageId>`. Returns `{}` when no row
 * references a shared source — the map is always present on the wire. The
 * accessible-set resolver runs lazily, only when at least one pointer exists,
 * so slot-free pages pay no access query.
 */
export async function resolvePublicMessageSlots(
  pool: Pool,
  workspaceId: string,
  resolveAccessibleStreamIds: () => Promise<readonly string[]>,
  contentJsons: Iterable<JSONContent | null | undefined>
): Promise<WireSlotMap> {
  const refs = new Map<string, SharedMessageRef>()
  for (const contentJson of contentJsons) {
    if (contentJson) collectSharedMessageRefs(contentJson, refs)
  }
  if (refs.size === 0) return {}

  const accessibleStreamIds = await resolveAccessibleStreamIds()
  const hydrated = await hydrateSharedMessageRefsForAccessibleSet(
    pool,
    workspaceId,
    new Set(accessibleStreamIds),
    refs.values()
  )
  const slots: WireSlotMap = {}
  for (const [slotKey, slot] of Object.entries(hydrated)) {
    slots[slotKey] = serializePublicSlot(slot)
  }
  return slots
}
