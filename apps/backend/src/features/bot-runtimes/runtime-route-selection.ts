import { HttpError } from "@threahq/backend-common"
import type { Querier } from "../../db"
import { BotRuntimeSessionLinkRepository, StreamActiveActorRepository } from "./repository"

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

  let link = await BotRuntimeSessionLinkRepository.findActiveByStreamForShare(db, {
    ...params,
    botId: active.actorId,
  })
  if (!link && params.activeStreamId !== params.rootStreamId) {
    link = await BotRuntimeSessionLinkRepository.findActiveByStreamForShare(db, {
      workspaceId: params.workspaceId,
      botId: active.actorId,
      rootStreamId: params.rootStreamId,
      activeStreamId: params.rootStreamId,
    })
  }
  return { botId: active.actorId, link }
}
