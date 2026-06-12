import { EXTERNAL_SEALED_DELIVERY, type SealingContext } from "@threa/agent-runtime"
import type { Querier } from "../../db"
import { E2eStreamsRepository } from "./repository"
import { E2eStreamActorsRepository } from "./actor-repository"

/**
 * The actor a dispatch site is about to hand a turn to, identified by its
 * authentication channel. The companion is in-process and holds no keys by
 * construction; the enclave and bots are pinned principals in
 * `e2e_stream_actors`.
 */
export type SealingActorRef = { kind: "companion" } | { kind: "enclave" } | { kind: "bot"; botId: string }

/**
 * Resolve the DB-backed inputs for `resolveDeliveryVerdict` (Phase 2.4a).
 * Threads carry their own `e2e_streams` and `e2e_stream_actors` rows (copied
 * from the root on creation), so the lookup is always against the message's
 * own stream id — no thread→root hop here.
 *
 * The grant is actor-row presence, not instance liveness: a momentarily-down
 * runtime must still produce a dispatchable verdict so park/revive can hold
 * the turn instead of the dispatch site silently dropping it.
 */
export async function resolveSealingContext(
  db: Querier,
  params: { workspaceId: string; streamId: string; actor: SealingActorRef }
): Promise<SealingContext> {
  const { workspaceId, streamId, actor } = params
  const streamIsE2e = await E2eStreamsRepository.isE2eStream(db, workspaceId, streamId)
  if (!streamIsE2e || actor.kind === "companion") {
    return { streamIsE2e, actorHasGrant: false, externalSealedDelivery: EXTERNAL_SEALED_DELIVERY }
  }
  const actors = await E2eStreamActorsRepository.listForStream(db, workspaceId, streamId)
  const actorHasGrant =
    actor.kind === "enclave"
      ? actors.some((a) => a.kind === "enclave")
      : actors.some((a) => a.kind === "bot" && a.actorId === actor.botId)
  return { streamIsE2e, actorHasGrant, externalSealedDelivery: EXTERNAL_SEALED_DELIVERY }
}
