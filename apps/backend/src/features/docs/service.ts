import type { Pool } from "pg"
import { AuthorTypes, StreamTypes, type AuthorType, type DocEditedEventPayload } from "@threahq/types"
import { withClient, withTransaction, type Querier } from "../../db"
import { HttpError, StreamNotFoundError } from "../../lib/errors"
import { eventId } from "../../lib/id"
import { OutboxRepository } from "../../lib/outbox"
import {
  StreamEventRepository,
  assertViewerStreamWritable,
  checkStreamAccess,
  resolveLockedStreamAuthorities,
  type Stream,
} from "../streams"
import { diffSections, projectDoc, type DocSection } from "./projection"
import { DocRepository, type DocHead, type DocUpdate } from "./repository"
import {
  DOC_SERVER_CLIENT_ID,
  DocUpdateInvalidError,
  DocUpdateNotApplicableError,
  applyClientWrite,
  decodeUpdateBase64,
  encodeFullState,
  encodeUpdateBase64,
  loadDocState,
} from "./yjs"

export const DOC_SNAPSHOT_INTERVAL = 200

export interface DocState {
  stream: Stream
  seq: number
  /** Base64 Yjs update holding the full state at `seq`. */
  state: string
  sections: DocSection[]
}

export interface DocUpdateView {
  seq: number
  update: string
  actorId: string
  actorType: AuthorType
}

type StoredUpdate = DocUpdate & { touchedBlockIds: string[] }

async function loadStoredState(db: Querier, workspaceId: string, docId: string) {
  const snapshot = await DocRepository.findLatestSnapshot(db, workspaceId, docId)
  const updates = await DocRepository.listUpdatesAfter(db, workspaceId, docId, snapshot?.seq ?? 0)
  const ydoc = loadDocState({ snapshot: snapshot?.state ?? null, updates: updates.map((update) => update.update) })
  return { ydoc, seq: updates.at(-1)?.seq ?? snapshot?.seq ?? 0 }
}

/** Takes the stream-chain lock, then the doc head's row lock. */
async function lockWritableDoc(
  db: Querier,
  params: { workspaceId: string; docId: string; userId: string }
): Promise<DocHead> {
  const [authority] = await resolveLockedStreamAuthorities(db, {
    workspaceId: params.workspaceId,
    streamIds: [params.docId],
    principal: { kind: "user", userId: params.userId },
    ignoreTypeReadOnly: true,
  })
  if (authority?.target.type !== StreamTypes.DOC) throw new StreamNotFoundError()
  assertViewerStreamWritable(authority.state)

  const head = await DocRepository.findHeadForUpdate(db, params.workspaceId, params.docId)
  if (!head) throw new Error(`Doc ${params.docId} has no head row`)
  return head
}

function applyOrRefuse(...args: Parameters<typeof applyClientWrite>): ReturnType<typeof applyClientWrite> {
  try {
    return applyClientWrite(...args)
  } catch (error) {
    if (error instanceof DocUpdateNotApplicableError) {
      throw new HttpError("Update depends on doc state the server does not have", {
        status: 400,
        code: "DOC_UPDATE_NOT_APPLICABLE",
      })
    }
    if (error instanceof DocUpdateInvalidError) {
      throw new HttpError("Update is not a valid doc update", { status: 400, code: "DOC_UPDATE_INVALID" })
    }
    throw error
  }
}

export class DocService {
  private pool: Pool

  constructor(deps: { pool: Pool }) {
    this.pool = deps.pool
  }

  async get(params: { workspaceId: string; userId: string; docId: string }): Promise<DocState> {
    return withClient(this.pool, async (client) => {
      const stream = await this.findReadableDoc(client, params)
      const { ydoc, seq } = await loadStoredState(client, params.workspaceId, params.docId)
      const sections = await DocRepository.listSections(client, params.workspaceId, params.docId)
      return { stream, seq, state: encodeUpdateBase64(encodeFullState(ydoc)), sections }
    })
  }

  async listUpdates(params: {
    workspaceId: string
    userId: string
    docId: string
    after: number
  }): Promise<DocUpdateView[]> {
    return withClient(this.pool, async (client) => {
      await this.findReadableDoc(client, params)
      const snapshot = await DocRepository.findLatestSnapshot(client, params.workspaceId, params.docId)
      if (snapshot && params.after < snapshot.seq) {
        throw new HttpError("Updates before the latest snapshot are not served; fetch the doc state instead", {
          status: 409,
          code: "DOC_UPDATES_BEHIND_SNAPSHOT",
        })
      }
      const updates = await DocRepository.listUpdatesAfter(client, params.workspaceId, params.docId, params.after)
      return updates.map(({ seq, update, actorId, actorType }) => ({
        seq,
        update: encodeUpdateBase64(update),
        actorId,
        actorType,
      }))
    })
  }

  /**
   * Applies a client Yjs update under the doc's row lock. When reading the
   * merged state repairs schema-invalid content or stamps block ids, that
   * server write is stored as its own system update, so the log alone replays
   * to the projected doc.
   */
  async postUpdate(params: {
    workspaceId: string
    userId: string
    docId: string
    update: string
  }): Promise<{ seq: number; touchedBlockIds: string[] }> {
    const { workspaceId, docId, userId } = params
    const clientUpdate = decodeUpdateBase64(params.update)

    return withTransaction(this.pool, async (client) => {
      const head = await lockWritableDoc(client, { workspaceId, docId, userId })
      const { ydoc } = await loadStoredState(client, workspaceId, docId)
      ydoc.clientID = DOC_SERVER_CLIENT_ID
      const { content, serverUpdate } = applyOrRefuse(ydoc, clientUpdate, head.bodyJson)

      const projection = projectDoc(content)
      const previousSections = await DocRepository.listSections(client, workspaceId, docId)
      const touchedBlockIds = diffSections(previousSections, projection.sections)

      const writes: Omit<StoredUpdate, "seq">[] = [
        { update: clientUpdate, actorId: userId, actorType: AuthorTypes.USER, touchedBlockIds },
      ]
      if (serverUpdate) {
        writes.push({
          update: serverUpdate,
          actorId: AuthorTypes.SYSTEM,
          actorType: AuthorTypes.SYSTEM,
          touchedBlockIds: [],
        })
      }
      const stored = writes.map((write, index): StoredUpdate => ({ ...write, seq: head.updateSeq + index + 1 }))
      const seq = stored.at(-1)!.seq

      for (const update of stored) {
        await DocRepository.insertUpdate(client, { workspaceId, docId, ...update })
      }
      if (Math.floor(seq / DOC_SNAPSHOT_INTERVAL) > Math.floor(head.updateSeq / DOC_SNAPSHOT_INTERVAL)) {
        await DocRepository.insertSnapshot(client, { workspaceId, docId, seq, state: encodeFullState(ydoc) })
      }
      await DocRepository.replaceSections(client, workspaceId, docId, projection.sections)
      await DocRepository.bumpHead(client, {
        workspaceId,
        streamId: docId,
        seq,
        bodyMarkdown: projection.bodyMarkdown,
        bodyJson: projection.bodyJson,
      })

      await StreamEventRepository.insert(client, {
        id: eventId(),
        workspaceId,
        streamId: docId,
        eventType: "doc:edited",
        payload: { seq, touchedBlockIds } satisfies DocEditedEventPayload,
        actorId: userId,
        actorType: AuthorTypes.USER,
      })
      for (const update of stored) {
        await OutboxRepository.insert(client, "doc:updated", {
          workspaceId,
          streamId: docId,
          seq: update.seq,
          update: encodeUpdateBase64(update.update),
          touchedBlockIds: update.touchedBlockIds,
          actorId: update.actorId,
          actorType: update.actorType,
        })
      }

      return { seq, touchedBlockIds }
    })
  }

  private async findReadableDoc(
    db: Querier,
    params: { workspaceId: string; userId: string; docId: string }
  ): Promise<Stream> {
    const stream = await checkStreamAccess(db, params.docId, params.workspaceId, params.userId)
    if (!stream || stream.type !== StreamTypes.DOC) throw new StreamNotFoundError()
    return stream
  }
}
