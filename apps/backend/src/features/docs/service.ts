import type { Pool } from "pg"
import * as Y from "yjs"
import {
  AuthorTypes,
  DocErrorCodes,
  StreamTypes,
  type AuthorType,
  type DocBacklink,
  type DocBlockThread,
  type DocEditedEventPayload,
  type DocPostUpdateResult,
  type DocSection,
  type DocState,
  type DocUpdateView,
} from "@threahq/types"
import { collectAttachmentReferenceIds } from "@threahq/prosemirror"
import { withClient, withTransaction, type Querier } from "../../db"
import { HttpError, StreamNotFoundError } from "../../lib/errors"
import { blockId, eventId } from "../../lib/id"
import { OutboxRepository } from "../../lib/outbox"
import { AttachmentRepository } from "../attachments"
import {
  StreamEventRepository,
  StreamRepository,
  assertViewerStreamWritable,
  checkStreamAccess,
  listAccessibleStreamIds,
  principalActorId,
  resolveLockedStreamAuthorities,
  type Stream,
  type StreamWritePrincipal,
} from "../streams"
import { buildContent, type DocRewrite } from "./agent-markdown"
import type { DocAgentEditRefusal } from "./agent-types"
import { diffSections, projectDoc, type DocProjection } from "./projection"
import { DocRepository, type DocHead, type DocUpdate } from "./repository"
import {
  DOC_SERVER_CLIENT_ID,
  DocUpdateInvalidError,
  DocUpdateNotApplicableError,
  applyClientWrite,
  applyServerContent,
  decodeUpdateBase64,
  encodeFullState,
  encodeUpdateBase64,
  isDecodableStateVector,
  loadDocState,
} from "./yjs"

export const DOC_SNAPSHOT_INTERVAL = 200

type StoredUpdate = DocUpdate & { touchedBlockIds: string[] }

type AuthoredWrite = Omit<StoredUpdate, "seq">

async function loadStoredState(db: Querier, workspaceId: string, docId: string) {
  const snapshot = await DocRepository.findLatestSnapshot(db, workspaceId, docId)
  const updates = await DocRepository.listUpdatesAfter(db, workspaceId, docId, snapshot?.seq ?? 0)
  const ydoc = loadDocState({ snapshot: snapshot?.state ?? null, updates: updates.map((update) => update.update) })
  return { ydoc, seq: updates.at(-1)?.seq ?? snapshot?.seq ?? 0 }
}

/** Takes the stream-chain lock, then the doc head's row lock. */
async function lockWritableDoc(
  db: Querier,
  params: { workspaceId: string; docId: string; principal: StreamWritePrincipal }
): Promise<{ doc: Stream; head: DocHead }> {
  const [authority] = await resolveLockedStreamAuthorities(db, {
    workspaceId: params.workspaceId,
    streamIds: [params.docId],
    principal: params.principal,
    typeReadOnly: "none",
  })
  if (authority?.target.type !== StreamTypes.DOC) throw new StreamNotFoundError()
  assertViewerStreamWritable(authority.state)

  const head = await DocRepository.findHeadForUpdate(db, params.workspaceId, params.docId)
  if (!head) throw new Error(`Doc ${params.docId} has no head row`)
  return { doc: authority.target, head }
}

function applyOrRefuse(...args: Parameters<typeof applyClientWrite>): ReturnType<typeof applyClientWrite> {
  try {
    return applyClientWrite(...args)
  } catch (error) {
    if (error instanceof DocUpdateNotApplicableError) {
      throw new HttpError("Update depends on doc state the server does not have", {
        status: 400,
        code: DocErrorCodes.UPDATE_NOT_APPLICABLE,
      })
    }
    if (error instanceof DocUpdateInvalidError) {
      throw new HttpError("Update is not a valid doc update", { status: 400, code: DocErrorCodes.UPDATE_INVALID })
    }
    throw error
  }
}

/** `title` is the doc's display name as read under the lock. */
export type DocAgentRewriteResult =
  | { status: "applied"; title: string | null; seq: number; touchedBlockIds: string[]; sections: DocSection[] }
  | { status: "unchanged"; title: string | null; seq: number }
  | { status: "edit_refused"; refusal: DocAgentEditRefusal }
  | { status: "invalid" }

/** `DocState` before serialization: the stream still carries `Date`s. */
type LoadedDocState = Omit<DocState, "stream"> & { stream: Stream }

export class DocService {
  private pool: Pool

  constructor(deps: { pool: Pool }) {
    this.pool = deps.pool
  }

  /** With `stateVector` (base64), `state` holds only what that vector lacks. */
  async get(params: {
    workspaceId: string
    userId: string
    docId: string
    stateVector?: string
  }): Promise<LoadedDocState> {
    const stateVector = params.stateVector === undefined ? undefined : decodeUpdateBase64(params.stateVector)
    if (stateVector && !isDecodableStateVector(stateVector)) {
      throw new HttpError("State vector is not a valid Yjs state vector", {
        status: 400,
        code: DocErrorCodes.STATE_VECTOR_INVALID,
      })
    }
    return withClient(this.pool, async (client) => {
      const stream = await this.findReadableDoc(client, params)
      const { ydoc, seq } = await loadStoredState(client, params.workspaceId, params.docId)
      const sections = await DocRepository.listSections(client, params.workspaceId, params.docId)
      return { stream, seq, state: encodeUpdateBase64(Y.encodeStateAsUpdate(ydoc, stateVector)), sections }
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
  }): Promise<DocPostUpdateResult> {
    const { workspaceId, docId, userId } = params
    const clientUpdate = decodeUpdateBase64(params.update)

    return withTransaction(this.pool, async (client) => {
      const { head } = await lockWritableDoc(client, { workspaceId, docId, principal: { kind: "user", userId } })
      const { ydoc } = await loadStoredState(client, workspaceId, docId)
      ydoc.clientID = DOC_SERVER_CLIENT_ID
      const write = applyOrRefuse(ydoc, clientUpdate, head.bodyJson)
      if (!write.applied) return { seq: head.updateSeq, applied: false, touchedBlockIds: [] }
      const { stored: clientWrite, content, serverUpdate } = write

      const projection = projectDoc(content, docId)
      const previousSections = await DocRepository.listSections(client, workspaceId, docId)
      const touchedBlockIds = diffSections(previousSections, projection.sections)

      const seq = await this.commitWrite(client, {
        head,
        ydoc,
        projection,
        authored: { update: clientWrite, actorId: userId, actorType: AuthorTypes.USER, touchedBlockIds },
        repair: serverUpdate,
        attachedBy: userId,
      })

      return { seq, applied: true, touchedBlockIds }
    })
  }

  /**
   * Rewrites the doc as the server on an agent's behalf, under the same lock
   * and log as `postUpdate`: authorized as `principal`, stored as one
   * update attributed to `actor`. `rewrite` receives the current sections, read
   * under the lock; when it refuses, nothing is written.
   */
  async applyAgentRewrite(params: {
    workspaceId: string
    docId: string
    principal: StreamWritePrincipal
    actor: { actorId: string; actorType: AuthorType }
    reason: string
    rewrite: (sections: DocSection[]) => DocRewrite
  }): Promise<DocAgentRewriteResult> {
    const { workspaceId, docId, principal, actor, reason } = params
    try {
      return await withTransaction(this.pool, async (client) => {
        const { doc, head } = await lockWritableDoc(client, { workspaceId, docId, principal })
        const title = doc.displayName ?? null
        const previousSections = await DocRepository.listSections(client, workspaceId, docId)
        const next = params.rewrite(previousSections)
        if (!next.ok) return { status: "edit_refused", refusal: next.refusal }

        const { ydoc } = await loadStoredState(client, workspaceId, docId)
        ydoc.clientID = DOC_SERVER_CLIENT_ID
        const json = buildContent(next.sections, head.bodyJson, blockId)
        const staging =
          next.reinserted === undefined
            ? undefined
            : { ...json, content: json.content?.filter((node) => node.attrs?.blockId !== next.reinserted) }
        const { update, content } = applyServerContent(ydoc, json, { staging })
        if (!update) return { status: "unchanged", title, seq: head.updateSeq }

        const projection = projectDoc(content, docId)
        const touchedBlockIds = diffSections(previousSections, projection.sections)
        const seq = await this.commitWrite(client, {
          head,
          ydoc,
          projection,
          authored: { update, ...actor, touchedBlockIds },
          repair: null,
          attachedBy: principalActorId(principal),
          reason,
        })
        return { status: "applied", title, seq, touchedBlockIds, sections: projection.sections }
      })
    } catch (error) {
      if (error instanceof DocUpdateInvalidError) return { status: "invalid" }
      throw error
    }
  }

  /**
   * Persists a write already applied to `ydoc` (the doc's next head after
   * `head`) and returns the new seq. `repair`, the server's read-time fix-up,
   * is stored after it as the system's, touching no blocks.
   */
  private async commitWrite(
    client: Querier,
    params: {
      head: DocHead
      ydoc: Y.Doc
      projection: DocProjection
      authored: AuthoredWrite
      repair: Uint8Array | null
      attachedBy: string
      reason?: string
    }
  ): Promise<number> {
    const { head, projection, authored } = params
    const { workspaceId, streamId: docId } = head
    const writes: AuthoredWrite[] = [authored]
    if (params.repair) {
      writes.push({
        update: params.repair,
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
      await DocRepository.insertSnapshot(client, { workspaceId, docId, seq, state: encodeFullState(params.ydoc) })
    }
    await DocRepository.replaceSections(client, workspaceId, docId, projection.sections)
    await DocRepository.replaceReferences(client, workspaceId, docId, projection.references)
    await DocRepository.bumpHead(client, {
      workspaceId,
      streamId: docId,
      seq,
      bodyMarkdown: projection.bodyMarkdown,
      bodyJson: projection.bodyJson,
    })
    await AttachmentRepository.attachToStream(
      client,
      workspaceId,
      collectAttachmentReferenceIds(projection.bodyJson),
      docId,
      params.attachedBy
    )

    const payload: DocEditedEventPayload = {
      seq,
      touchedBlockIds: authored.touchedBlockIds,
      ...(params.reason === undefined ? {} : { reason: params.reason }),
    }
    await StreamEventRepository.insert(client, {
      id: eventId(),
      workspaceId,
      streamId: docId,
      eventType: "doc:edited",
      payload,
      actorId: authored.actorId,
      actorType: authored.actorType,
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
    return seq
  }

  async listThreads(params: { workspaceId: string; userId: string; docId: string }): Promise<DocBlockThread[]> {
    return withClient(this.pool, async (client) => {
      await this.findReadableDoc(client, params)
      const threads = await StreamRepository.findThreadsWithReplyCounts(client, params.workspaceId, params.docId)
      return [...threads].map(([blockId, { threadId, replyCount }]) => ({ blockId, threadId, replyCount }))
    })
  }

  async listBacklinks(params: { workspaceId: string; userId: string; docId: string }): Promise<DocBacklink[]> {
    const { workspaceId, userId, docId } = params
    return withClient(this.pool, async (client) => {
      await this.findReadableDoc(client, params)
      const rows = await DocRepository.listBacklinks(client, workspaceId, docId)
      const blockIdsByDoc = new Map(rows.map((row) => [row.docId, row.blockIds]))
      const accessible = await listAccessibleStreamIds(client, workspaceId, userId, [...blockIdsByDoc.keys()])
      const active = await StreamRepository.filterEffectivelyActiveIds(client, workspaceId, [...accessible])
      const docs = await StreamRepository.findByIds(client, workspaceId, active)
      return docs
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .flatMap((doc) =>
          doc.type === StreamTypes.DOC && doc.parentStreamId
            ? [
                {
                  docId: doc.id,
                  title: doc.displayName ?? null,
                  hostStreamId: doc.parentStreamId,
                  blockIds: blockIdsByDoc.get(doc.id)!,
                },
              ]
            : []
        )
    })
  }

  async getSection(params: {
    workspaceId: string
    userId: string
    docId: string
    blockId: string
  }): Promise<DocSection> {
    return withClient(this.pool, async (client) => {
      await this.findReadableDoc(client, params)
      const section = await DocRepository.findSection(client, params.workspaceId, params.docId, params.blockId)
      if (!section) {
        throw new HttpError("Doc section not found", { status: 404, code: DocErrorCodes.SECTION_NOT_FOUND })
      }
      return section
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
