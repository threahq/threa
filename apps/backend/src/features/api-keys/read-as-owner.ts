import type { Querier } from "../../db"
import { E2eStreamsRepository } from "../e2e-streams"
import { StreamRepository, checkStreamAccess } from "../streams"
import { BotChannelAccessRepository } from "./repository"

/**
 * The read-as-owner arm as a point check: a personal bot with
 * `bots.reads_as_owner` reads whatever its delegating owner reads (the
 * canonical INV-62 predicate, threads resolved through their root), minus
 * archived streams and E2E-rooted ones — read-as-owner never shortcuts the
 * grant + key-wrap path an E2E stream requires. Evaluated per call, so the
 * owner losing access revokes the bot's in the same moment.
 *
 * Single definition on purpose: the read gate (`BotChannelService`) and the
 * write authority's 404-vs-403 decision must agree on exactly which streams
 * this arm covers, or the write path softens existence hiding for a stream the
 * bot cannot actually read. Takes a `Querier` so the write authority can call
 * it inside its transaction.
 */
export async function isStreamReadableAsOwner(
  db: Querier,
  workspaceId: string,
  botId: string,
  streamId: string
): Promise<boolean> {
  const ownerUserId = await BotChannelAccessRepository.getReadAsOwnerDelegate(db, workspaceId, botId)
  if (!ownerUserId) return false

  const stream = await StreamRepository.findByIdForWorkspace(db, streamId, workspaceId)
  if (!stream || stream.archivedAt) return false

  const readable = await checkStreamAccess(db, streamId, workspaceId, ownerUserId)
  if (!readable) return false

  // The root's archived_at matters on its own: a thread stays unarchived when
  // its root archives, and the owner can still read it — this arm must not.
  if (readable.rootStreamId) {
    const root = await StreamRepository.findById(db, readable.rootStreamId)
    if (!root || root.archivedAt) return false
  }

  return !(await E2eStreamsRepository.isE2eStream(db, workspaceId, readable.rootStreamId ?? readable.id))
}
