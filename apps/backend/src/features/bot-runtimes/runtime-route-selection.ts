import { HttpError } from "@threahq/backend-common"
import type { Querier } from "../../db"
import { BotRuntimeSessionLinkRepository, StreamActiveActorRepository } from "./repository"

/** The bot's link on the stream itself, else the one on its root. */
export async function findBotLinkCoveringStream(
  db: Querier,
  params: { workspaceId: string; botId: string; rootStreamId: string; activeStreamId: string }
) {
  const onStream = await BotRuntimeSessionLinkRepository.findActiveByStreamForShare(db, params)
  if (onStream || params.activeStreamId === params.rootStreamId) return onStream
  return BotRuntimeSessionLinkRepository.findActiveByStreamForShare(db, {
    ...params,
    activeStreamId: params.rootStreamId,
  })
}

export async function resolveLinkedRuntimeRouteTarget(
  db: Querier,
  params: { workspaceId: string; rootStreamId: string; activeStreamId: string }
) {
  if (params.activeStreamId !== params.rootStreamId) {
    const links = await BotRuntimeSessionLinkRepository.listActiveByStreamForShare(db, params)
    if (links.length > 1) {
      throw new HttpError("Multiple runtime sessions are linked to this thread", {
        status: 409,
        code: "RUNTIME_ROUTE_AMBIGUOUS",
      })
    }
    const childLink = links[0]
    if (childLink) return { botId: childLink.botId, link: childLink }
  }

  const active = await StreamActiveActorRepository.findByRootStream(db, params.workspaceId, params.rootStreamId)
  if (!active || active.actorType !== "bot") return null

  const link = await findBotLinkCoveringStream(db, { ...params, botId: active.actorId })
  return { botId: active.actorId, link }
}
