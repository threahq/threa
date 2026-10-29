import type { Pool } from "pg"
import { collectMentionActorRefs } from "@threahq/prosemirror"
import { ActivityTypes, AuthorTypes, StreamTypes, markdownLines, type DocEditedEventPayload } from "@threahq/types"
import { withTransaction, type Querier } from "../../db"
import { logger } from "../../lib/logger"
import { JobQueues, type DocMentionSettleJobData, type QueueManager } from "../../lib/queue"
import { truncateCodePoints } from "../../lib/truncate"
import { ActivityRepository, insertActivityCreatedEvents, type Activity } from "../activity"
import { listUsersWithStreamAccess, StreamRepository } from "../streams"
import { PeoplePurposes, peopleViewerForActor, UserRepository } from "../workspaces"
import { listEditsAfter } from "./activity-service"
import { DOC_MENTION_QUIET_MS } from "./config"
import {
  DocMentionEditRepository,
  DocMentionNotificationRepository,
  DocMentionStateRepository,
} from "./mention-repository"
import { DocRepository } from "./repository"

/** Bounds a clock-skew requeue loop; the author's next write schedules a fresh chain. */
const MAX_SETTLE_HOPS = 5

const PREVIEW_MAX_CODE_POINTS = 200

/** One queue-message id per (doc, author) per quiet window; a reschedule's hop keeps it off the id its own run claimed. */
export function docMentionSettleJobId(docId: string, actorId: string, at: Date, hop = 0): string {
  const base = `doc-mention:${docId}:${actorId}:${Math.floor(at.getTime() / DOC_MENTION_QUIET_MS)}`
  return hop > 0 ? `${base}:h${hop}` : base
}

export type DocMentionSettleResult =
  | { status: "settled"; activityIds: string[] }
  | { status: "nothing" }
  | { status: "abandoned" }
  | { status: "requeued"; processAfter: Date; activityIds: string[] }

/**
 * Notifies users mentioned in a doc once the author has settled the block holding the mention:
 * the author left the block for another one, or has not touched it for `DOC_MENTION_QUIET_MS`.
 * Mentions are read from the block as it stands at settle time, so one typed and deleted again
 * before then notifies no one.
 */
export class DocMentionService {
  private readonly pool: Pool
  private readonly jobQueue: Pick<QueueManager, "send">

  constructor(deps: { pool: Pool; jobQueue: Pick<QueueManager, "send"> }) {
    this.pool = deps.pool
    this.jobQueue = deps.jobQueue
  }

  async settle(params: DocMentionSettleJobData): Promise<DocMentionSettleResult> {
    const { workspaceId, docId, actorId } = params
    const result = await withTransaction(this.pool, (client) => this.settleInTransaction(client, params))
    if (result.status !== "requeued") return result

    const hop = (params.hop ?? 0) + 1
    if (hop > MAX_SETTLE_HOPS) {
      logger.warn({ workspaceId, docId, actorId, hop }, "Giving up doc mention settle after too many hops")
      return { status: "abandoned" }
    }
    await this.jobQueue.send(
      JobQueues.DOC_MENTION_SETTLE,
      { workspaceId, docId, actorId, hop },
      { processAfter: result.processAfter, messageId: docMentionSettleJobId(docId, actorId, result.processAfter, hop) }
    )
    return result
  }

  private async settleInTransaction(db: Querier, params: DocMentionSettleJobData): Promise<DocMentionSettleResult> {
    const { workspaceId, docId, actorId } = params
    const { settledSequence, now } = await DocMentionStateRepository.lockSettledSequence(
      db,
      workspaceId,
      docId,
      actorId
    )
    const authored = (await listEditsAfter(db, workspaceId, docId, settledSequence, actorId)).filter(
      (edit) => (edit.payload as DocEditedEventPayload).touchedBlockIds.length > 0
    )
    const latest = authored.at(-1)
    if (!latest) return { status: "nothing" }

    // Every block but those the author's latest write touched was left for another one. Those settle
    // once the author has been away from them for the quiet window, or at once after a rewrite.
    const latestPayload = latest.payload as DocEditedEventPayload
    const latestSettles =
      latestPayload.reason !== undefined || latest.createdAt.getTime() + DOC_MENTION_QUIET_MS <= now.getTime()
    const pending = new Set(latestSettles ? [] : latestPayload.touchedBlockIds)
    const lastTouches = new Map<string, bigint>()
    for (const edit of authored) {
      for (const blockId of (edit.payload as DocEditedEventPayload).touchedBlockIds) {
        if (!pending.has(blockId)) lastTouches.set(blockId, edit.sequence)
      }
    }
    await DocMentionStateRepository.setSettledSequence(
      db,
      workspaceId,
      docId,
      actorId,
      latestSettles ? latest.sequence : latest.sequence - 1n
    )

    // A block someone else touched after this author is theirs to settle, under their name.
    const touchedByOthers = await DocMentionEditRepository.latestTouchesByOthers(db, {
      workspaceId,
      docId,
      actorId,
      afterSequence: authored[0]!.sequence,
      blockIds: [...lastTouches.keys()],
    })
    const settled = [...lastTouches].flatMap(([blockId, sequence]) =>
      (touchedByOthers.get(blockId) ?? 0n) > sequence ? [] : [blockId]
    )

    const activities = await this.notify(db, {
      workspaceId,
      docId,
      actorId,
      actorType: latest.actorType!,
      blockIds: settled,
    })
    const activityIds = activities.map((activity) => activity.id)
    if (!latestSettles) {
      return {
        status: "requeued",
        processAfter: new Date(latest.createdAt.getTime() + DOC_MENTION_QUIET_MS),
        activityIds,
      }
    }
    return activityIds.length > 0 ? { status: "settled", activityIds } : { status: "nothing" }
  }

  private async notify(
    db: Querier,
    params: { workspaceId: string; docId: string; actorId: string; actorType: string; blockIds: string[] }
  ): Promise<Activity[]> {
    const { workspaceId, docId, actorId, actorType } = params
    if (params.blockIds.length === 0) return []
    const doc = await StreamRepository.findById(db, workspaceId, docId)
    if (doc?.type !== StreamTypes.DOC) return []

    const settledIds = new Set(params.blockIds)
    const mentionsByBlock = new Map<string, { preview: string; userIds: string[] }>()
    for (const section of await DocRepository.listSections(db, workspaceId, docId)) {
      if (!settledIds.has(section.blockId)) continue
      const userIds = collectMentionActorRefs(section.contentJson)
        .filter((ref) => ref.actorType === AuthorTypes.USER && ref.actorId !== actorId)
        .map((ref) => ref.actorId)
      if (userIds.length === 0) continue
      const preview = truncateCodePoints(markdownLines(section.markdown)[0] ?? "", PREVIEW_MAX_CODE_POINTS)
      mentionsByBlock.set(section.blockId, { preview, userIds: [...new Set(userIds)] })
    }
    const candidateIds = [...new Set([...mentionsByBlock.values()].flatMap((block) => block.userIds))]
    if (candidateIds.length === 0) return []

    const targetable = await UserRepository.findByIds(db, workspaceId, candidateIds, {
      viewer: peopleViewerForActor(actorType, actorId),
      purpose: PeoplePurposes.TARGETABLE,
    })
    const readers = await listUsersWithStreamAccess(
      db,
      workspaceId,
      docId,
      targetable.map((user) => user.id)
    )
    const claimed = await DocMentionNotificationRepository.claim(db, {
      workspaceId,
      docId,
      actorId,
      claims: [...mentionsByBlock].flatMap(([blockId, block]) =>
        block.userIds.filter((userId) => readers.has(userId)).map((userId) => ({ blockId, userId }))
      ),
    })
    if (claimed.length === 0) return []

    const activities: Activity[] = []
    for (const [blockId, block] of mentionsByBlock) {
      const userIds = claimed.filter((claim) => claim.blockId === blockId).map((claim) => claim.userId)
      activities.push(
        ...(await ActivityRepository.insertBatch(db, {
          workspaceId,
          userIds,
          activityType: ActivityTypes.DOC_MENTION,
          streamId: docId,
          messageId: blockId,
          actorId,
          actorType,
          context: { contentPreview: block.preview, streamName: doc.displayName ?? null },
        }))
      )
    }
    await insertActivityCreatedEvents(db, activities)
    return activities
  }
}
