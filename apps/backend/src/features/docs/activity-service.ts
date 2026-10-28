import type { Pool } from "pg"
import {
  AuthorTypes,
  markdownLines,
  type DocActivityEventPayload,
  type DocActivitySection,
  type DocEditedEventPayload,
} from "@threahq/types"
import { withTransaction, type Querier } from "../../db"
import { eventId } from "../../lib/id"
import { logger } from "../../lib/logger"
import { OutboxRepository } from "../../lib/outbox"
import { JobQueues, type DocActivityRollupJobData, type QueueManager } from "../../lib/queue"
import { StreamEventRepository, StreamRepository, listAccessibleStreamIds, type StreamEvent } from "../streams"
import type { BotChannelService } from "../api-keys"
import { DocActivityStateRepository } from "./activity-repository"
import { DOC_ACTIVITY_MAX_REASONS, DOC_ACTIVITY_QUIET_MS } from "./config"
import { DocRepository } from "./repository"

/** Bounds a clock-skew requeue loop; whatever a stopped chain left unfolded rides the next edit's window. */
const MAX_ROLLUP_HOPS = 5

const EDIT_PAGE_SIZE = 500

/** One queue-message id per doc per quiet window; a reschedule's hop keeps it off the id its own run claimed. */
export function docActivityRollupJobId(docId: string, at: Date, hop = 0): string {
  const base = `doc-activity:${docId}:${Math.floor(at.getTime() / DOC_ACTIVITY_QUIET_MS)}`
  return hop > 0 ? `${base}:h${hop}` : base
}

export type DocActivityRollUpResult =
  | { status: "appended"; eventId: string }
  | { status: "nothing" }
  | { status: "abandoned" }
  | { status: "skipped" }
  | { status: "requeued"; processAfter: Date }

export async function listEditsAfter(
  db: Querier,
  workspaceId: string,
  docId: string,
  afterSequence: bigint,
  actorId?: string
) {
  const edits: StreamEvent[] = []
  for (let cursor = afterSequence; ; ) {
    const page = await StreamEventRepository.list(db, workspaceId, docId, {
      types: ["doc:edited"],
      afterSequence: cursor,
      limit: EDIT_PAGE_SIZE,
      actorId,
    })
    edits.push(...page)
    if (page.length < EDIT_PAGE_SIZE) return edits
    cursor = page.at(-1)!.sequence
  }
}

export class DocActivityService {
  private readonly pool: Pool
  private readonly jobQueue: Pick<QueueManager, "send">
  private readonly botChannelService: Pick<BotChannelService, "isStreamAccessibleForBot">
  private readonly now: () => Date

  constructor(deps: {
    pool: Pool
    jobQueue: Pick<QueueManager, "send">
    botChannelService: Pick<BotChannelService, "isStreamAccessibleForBot">
    now?: () => Date
  }) {
    this.pool = deps.pool
    this.jobQueue = deps.jobQueue
    this.botChannelService = deps.botChannelService
    this.now = deps.now ?? (() => new Date())
  }

  async rollUp(params: DocActivityRollupJobData): Promise<DocActivityRollUpResult> {
    const { workspaceId, docId } = params
    const hop = params.hop ?? 0
    const result = await withTransaction(this.pool, (client) => this.fold(client, workspaceId, docId))
    if (result.status !== "requeued") return result

    const nextHop = hop + 1
    if (nextHop > MAX_ROLLUP_HOPS) {
      logger.warn(
        { workspaceId, docId, hop: nextHop },
        "Giving up doc activity roll-up after too many quiet-window hops"
      )
      return { status: "abandoned" }
    }
    await this.jobQueue.send(
      JobQueues.DOC_ACTIVITY_ROLLUP,
      { workspaceId, docId, hop: nextHop },
      { processAfter: result.processAfter, messageId: docActivityRollupJobId(docId, result.processAfter, nextHop) }
    )
    return result
  }

  private async fold(db: Querier, workspaceId: string, docId: string): Promise<DocActivityRollUpResult> {
    const doc = await StreamRepository.findById(db, workspaceId, docId)
    if (!doc?.parentStreamId) {
      logger.warn({ workspaceId, docId }, "Doc activity roll-up found no doc to fold")
      return { status: "nothing" }
    }
    const cursor = await DocActivityStateRepository.lockCursor(db, workspaceId, docId)
    const head = await DocRepository.findHead(db, workspaceId, docId)
    if (!head) {
      logger.warn({ workspaceId, docId }, "Doc activity roll-up found no doc head to fold")
      return { status: "nothing" }
    }

    const quietAt = new Date(head.updatedAt.getTime() + DOC_ACTIVITY_QUIET_MS)
    if (quietAt > this.now()) return { status: "requeued", processAfter: quietAt }

    const edits = await listEditsAfter(db, workspaceId, docId, cursor.foldedSequence)
    const toSequence = edits.at(-1)?.sequence
    if (toSequence === undefined) return { status: "nothing" }
    const present = await DocRepository.listSections(db, workspaceId, docId)
    const presentIds = new Set(present.map((section) => section.blockId))
    await DocActivityStateRepository.setCursor(db, workspaceId, docId, {
      foldedSequence: toSequence,
      blockIds: [...presentIds],
    })

    const host = await StreamRepository.findById(db, workspaceId, doc.parentStreamId)
    if (!host || host.archivedAt || doc.archivedAt) return { status: "skipped" }

    const authored = edits.filter((edit) => edit.actorId && edit.actorType && edit.actorType !== AuthorTypes.SYSTEM)
    const readers = await this.actorsReadingDoc(db, workspaceId, docId, authored)
    const folded = authored.filter((edit) => readers.has(`${edit.actorType}:${edit.actorId}`))
    if (folded.length === 0) return { status: "nothing" }

    const actors = new Map<string, DocActivityEventPayload["actors"][number]>()
    const touched = new Set<string>()
    const reasons = new Set<string>()
    for (const edit of folded) {
      const payload = edit.payload as DocEditedEventPayload
      actors.set(`${edit.actorType}:${edit.actorId}`, { actorId: edit.actorId!, actorType: edit.actorType! })
      for (const blockId of payload.touchedBlockIds) touched.add(blockId)
      if (payload.reason) {
        reasons.delete(payload.reason)
        reasons.add(payload.reason)
      }
    }
    const sections: DocActivitySection[] = present
      .filter((section) => touched.has(section.blockId))
      .map(({ blockId, kind, markdown }) => ({ blockId, kind, markdown: markdownLines(markdown)[0]! }))
    // The last editor authors the row: the unread divider skips a viewer's own rows, and whoever edited
    // last has already seen the doc as it stands.
    const lastEdit = folded.at(-1)!

    const event = await StreamEventRepository.insert(db, {
      id: eventId(),
      workspaceId,
      streamId: host.id,
      eventType: "doc:activity",
      payload: {
        docId,
        actors: [...actors.values()],
        sections,
        removedBlockIds: (cursor.blockIds ?? []).filter((blockId) => !presentIds.has(blockId)),
        editCount: folded.length,
        reasons: [...reasons].slice(-DOC_ACTIVITY_MAX_REASONS),
        fromSequence: folded[0]!.sequence.toString(),
        toSequence: folded.at(-1)!.sequence.toString(),
      } satisfies DocActivityEventPayload,
      actorId: lastEdit.actorId!,
      actorType: lastEdit.actorType!,
    })
    await OutboxRepository.insert(db, "stream:doc_activity", { workspaceId, streamId: host.id, event })
    return { status: "appended", eventId: event.id }
  }
  /**
   * The edit authors the host's row may name: a doc moved since an edit takes it to a host its author may
   * not read. Users and bots are checked against the doc as it stands; a persona has no access of its own.
   */
  private async actorsReadingDoc(
    db: Querier,
    workspaceId: string,
    docId: string,
    edits: readonly StreamEvent[]
  ): Promise<Set<string>> {
    const readers = new Set<string>()
    for (const key of new Set(edits.map((edit) => `${edit.actorType}:${edit.actorId}`))) {
      const [actorType, actorId] = key.split(":") as [string, string]
      const reads =
        actorType === AuthorTypes.USER
          ? (await listAccessibleStreamIds(db, workspaceId, actorId, [docId])).has(docId)
          : actorType !== AuthorTypes.BOT ||
            (await this.botChannelService.isStreamAccessibleForBot(workspaceId, actorId, docId))
      if (reads) readers.add(key)
    }
    return readers
  }
}
