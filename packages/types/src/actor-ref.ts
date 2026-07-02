/**
 * Authoritative actor/stream references carried by `mention`/`channelLink`
 * nodes' `attrs.id` (INV-64). The `slug` attr is a display label only; backend
 * logic resolves mentions by id, never slug. A node whose id is a bare slug (no
 * known prefix) is "unresolved" and gets rewritten at ingestion by the mentions
 * resolver. Broadcast mentions carry a sentinel id instead of a DB row id.
 */

export type MentionActorType = "user" | "persona" | "bot"

export interface MentionActorRef {
  actorType: MentionActorType
  actorId: string
}

export const MENTION_BROADCAST_HERE = "broadcast:here"
export const MENTION_BROADCAST_CHANNEL = "broadcast:channel"

const USER_ID_PREFIX = "usr_"
const PERSONA_ID_PREFIX = "persona_"
const BOT_ID_PREFIX = "bot_"
const STREAM_ID_PREFIX = "stream_"
const BROADCAST_ID_PREFIX = "broadcast:"

/**
 * A mention id is resolved when it carries a known actor prefix
 * (`usr_`/`persona_`/`bot_`) or is a broadcast sentinel. A bare slug is not.
 */
export function isResolvedMentionId(id: string): boolean {
  return (
    id.startsWith(USER_ID_PREFIX) ||
    id.startsWith(PERSONA_ID_PREFIX) ||
    id.startsWith(BOT_ID_PREFIX) ||
    id.startsWith(BROADCAST_ID_PREFIX)
  )
}

export function isResolvedChannelLinkId(id: string): boolean {
  return id.startsWith(STREAM_ID_PREFIX)
}

/**
 * Derive the actor kind from a resolved mention id's prefix. Returns
 * `"broadcast"` for sentinel ids and `null` for an unresolved (bare-slug) id.
 */
export function actorTypeFromMentionId(id: string): MentionActorType | "broadcast" | null {
  if (id.startsWith(USER_ID_PREFIX)) return "user"
  if (id.startsWith(PERSONA_ID_PREFIX)) return "persona"
  if (id.startsWith(BOT_ID_PREFIX)) return "bot"
  if (id.startsWith(BROADCAST_ID_PREFIX)) return "broadcast"
  return null
}
