import type { Querier } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { logger } from "../../lib/logger"
import { BotRuntimeSessionLinkRepository } from "./repository"

/**
 * Ends every active runtime link attached to `streamIds` and tells each linked runtime over the /bot
 * socket, in the caller's transaction (INV-4/INV-7). Already-ended links return no rows, so a retry
 * notifies nothing twice.
 */
export async function endSessionLinksForStreams(
  db: Querier,
  params: { workspaceId: string; streamIds: readonly string[]; cause: string }
): Promise<number> {
  const ended = await BotRuntimeSessionLinkRepository.archiveActiveByStreams(db, params)
  for (const link of ended) {
    await OutboxRepository.insert(db, "bot:session_archived", {
      workspaceId: params.workspaceId,
      botId: link.botId,
      instanceId: link.instanceId,
      runtimeSessionId: link.runtimeSessionId,
      rootStreamId: link.rootStreamId,
    })
  }
  if (ended.length > 0) {
    logger.info(
      { workspaceId: params.workspaceId, streamIds: params.streamIds, endedLinks: ended.length, cause: params.cause },
      "Ended runtime session links"
    )
  }
  return ended.length
}
