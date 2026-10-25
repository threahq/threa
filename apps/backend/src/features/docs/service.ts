import type { Pool } from "pg"
import { ensureBlockIds } from "@threahq/prosemirror"
import { InvalidContentError } from "@threahq/prosemirror/schema"
import { AuthorTypes, StreamTypes, type AuthorType, type DocEditedEventPayload, type JSONContent } from "@threahq/types"
import { withClient, withTransaction, type Querier } from "../../db"
import { HttpError, StreamNotFoundError } from "../../lib/errors"
import { blockId, eventId } from "../../lib/id"
import { OutboxRepository } from "../../lib/outbox"
import {
  StreamEventRepository,
  assertViewerStreamWritable,
  checkStreamAccess,
  resolveLockedStreamAuthorities,
  type Stream,
  type StreamWritePrincipal,
} from "../streams"
import { diffSections, projectDoc, type DocSection } from "./projection"
import { DocRepository } from "./repository"
import {
  DocUpdateNotApplicableError,
  applyClientUpdate,
  decodeUpdateBase64,
  encodeFullState,
  encodeUpdateBase64,
  loadDocState,
  writeContentJson,
  ydocToContentJson,
} from "./yjs"

export const DOC_SNAPSHOT_INTERVAL = 200

export type DocWriterType = typeof AuthorTypes.USER | typeof AuthorTypes.BOT

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

interface StoredUpdate {
  seq: number
  update: Uint8Array
  actorId: string
  actorType: AuthorType
}

async function loadStoredState(db: Querier, workspaceId: string, docId: string) {
  const snapshot = await DocRepository.findLatestSnapshot(db, workspaceId, docId)
  const updates = await DocRepository.listUpdatesAfter(db, workspaceId, docId, snapshot?.seq ?? 0)
  const ydoc = loadDocState({ snapshot: snapshot?.state ?? null, updates: updates.map((update) => update.update) })
  return { ydoc, seq: updates.at(-1)?.seq ?? snapshot?.seq ?? 0 }
}

function writePrincipal(actorId: string, actorType: DocWriterType): StreamWritePrincipal {
  return actorType === AuthorTypes.BOT ? { kind: "bot", botId: actorId } : { kind: "user", userId: actorId }
}

function invalidUpdate(error: unknown): HttpError {
  if (error instanceof DocUpdateNotApplicableError) {
    return new HttpError("Update depends on doc state the server does not have", {
      status: 400,
      code: "DOC_UPDATE_NOT_APPLICABLE",
    })
  }
  return new HttpError("Update is not a valid doc update", { status: 400, code: "DOC_UPDATE_INVALID" })
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
   * Applies a client Yjs update under the doc's row lock. When the result has
   * a top-level block without a unique id, the server stamps ids and stores
   * that write as its own update, so the log alone replays to a stamped doc.
   */
  async postUpdate(params: {
    workspaceId: string
    actorId: string
    actorType: DocWriterType
    docId: string
    update: string
  }): Promise<{ seq: number; touchedBlockIds: string[] }> {
    const { workspaceId, docId } = params
    const clientUpdate = decodeUpdateBase64(params.update)

    return withTransaction(this.pool, async (client) => {
      const [authority] = await resolveLockedStreamAuthorities(client, {
        workspaceId,
        streamIds: [docId],
        principal: writePrincipal(params.actorId, params.actorType),
        ignoreTypeReadOnly: true,
      })
      if (authority!.target.type !== StreamTypes.DOC) throw new StreamNotFoundError()
      assertViewerStreamWritable(authority!.state)

      const head = await DocRepository.findHeadForUpdate(client, workspaceId, docId)
      if (!head) throw new Error(`Doc ${docId} has no head row`)

      const { ydoc } = await loadStoredState(client, workspaceId, docId)
      try {
        applyClientUpdate(ydoc, clientUpdate)
      } catch (error) {
        throw invalidUpdate(error)
      }
      let json: JSONContent
      try {
        json = ydocToContentJson(ydoc)
      } catch (error) {
        if (error instanceof InvalidContentError) throw invalidUpdate(error)
        throw error
      }

      const stored: StoredUpdate[] = [
        { seq: head.updateSeq + 1, update: clientUpdate, actorId: params.actorId, actorType: params.actorType },
      ]
      const stamped = ensureBlockIds(json, blockId, head.bodyJson)
      if (stamped !== json) {
        stored.push({
          seq: head.updateSeq + 2,
          update: writeContentJson(ydoc, stamped),
          actorId: AuthorTypes.SYSTEM,
          actorType: AuthorTypes.SYSTEM,
        })
      }
      const seq = stored.at(-1)!.seq

      const projection = projectDoc(ydocToContentJson(ydoc))
      const previousSections = await DocRepository.listSections(client, workspaceId, docId)
      const touchedBlockIds = diffSections(previousSections, projection.sections)

      for (const update of stored) {
        await DocRepository.insertUpdate(client, { workspaceId, docId, ...update })
      }
      const snapshotDue = Math.floor(seq / DOC_SNAPSHOT_INTERVAL) > Math.floor(head.updateSeq / DOC_SNAPSHOT_INTERVAL)
      if (snapshotDue) {
        await DocRepository.insertSnapshot(client, { workspaceId, docId, seq, state: encodeFullState(ydoc) })
      }
      await DocRepository.replaceSections(client, workspaceId, docId, projection.sections)
      const bumped = await DocRepository.bumpHead(client, {
        workspaceId,
        streamId: docId,
        seq,
        bodyMarkdown: projection.bodyMarkdown,
        bodyJson: projection.bodyJson,
        snapshotSeq: snapshotDue ? seq : undefined,
      })
      if (!bumped) throw new Error(`Doc ${docId} head moved past ${seq} under its row lock`)

      await StreamEventRepository.insert(client, {
        id: eventId(),
        workspaceId,
        streamId: docId,
        eventType: "doc:edited",
        payload: {
          seq,
          touchedBlockIds,
          actorId: params.actorId,
          actorType: params.actorType,
        } satisfies DocEditedEventPayload,
        actorId: params.actorId,
        actorType: params.actorType,
      })
      for (const [index, update] of stored.entries()) {
        await OutboxRepository.insert(client, "doc:updated", {
          workspaceId,
          streamId: docId,
          seq: update.seq,
          update: encodeUpdateBase64(update.update),
          touchedBlockIds: index === 0 ? touchedBlockIds : [],
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
