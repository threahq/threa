import type { Request, Response } from "express"
import type { Pool } from "pg"
import { DocErrorCodes, StreamErrorCodes, StreamTypes } from "@threahq/types"
import { HttpError } from "../../lib/errors"
import { DocRepository } from "../docs"
import { StreamRepository, type Stream, type StreamService } from "../streams"
import { callerIsWorkspaceAdmin } from "../../middleware/workspace-admin"
import { validateRequest } from "../../lib/validation"
import type {
  DocAgentAccessRefusal,
  DocAgentContext,
  DocAgentDocSummary,
  DocAgentEditRefusal,
  DocAgentService,
  DocAgentWriteResult,
} from "../docs"
import { principalActorId } from "../streams"
import { decodeCursor, encodeCursor } from "./cursor"
import type { EventService } from "../messaging"
import { createMessageAsKey, plaintextMessageBody } from "./handlers"
import { apiKeyPrincipal } from "./principal"
import {
  commentOnDocSectionSchema,
  createDocSchema,
  docIdParamSchema,
  docSectionParamSchema,
  editDocSchema,
  listDocsQuerySchema,
  moveDocSchema,
} from "./schemas"

function keyContext<Host extends string | null>(
  req: Request,
  hostStreamId: Host
): DocAgentContext & { hostStreamId: Host } {
  const principal = apiKeyPrincipal(req)
  const actor = { actorId: principalActorId(principal), actorType: principal.kind }
  return { workspaceId: req.workspaceId!, hostStreamId, principal, actor }
}

function notFound(): HttpError {
  return new HttpError("Doc not found", { status: 404, code: "NOT_FOUND" })
}

/** The wire form of a refusal: unreachable reads as missing, a write the principal may not make says why. */
function accessError(refusal: DocAgentAccessRefusal): HttpError {
  if (refusal.status === "not_found") return notFound()
  switch (refusal.code) {
    case "not_a_member":
    case "read_only":
    case "archived":
      return new HttpError("This doc is read-only", {
        status: 403,
        code: StreamErrorCodes.READ_ONLY,
        details: { reason: refusal.reason },
      })
    case "host_cannot_host_docs":
      return new HttpError("This stream cannot host docs", { status: 400, code: DocErrorCodes.HOST_TYPE_INVALID })
    case "e2e_host":
      return new HttpError("Docs cannot live under an end-to-end encrypted stream", {
        status: 400,
        code: DocErrorCodes.E2E_HOST_NOT_ALLOWED,
      })
    case "title_empty":
      return new HttpError("Title must not be blank", { status: 400, code: "VALIDATION_ERROR" })
    case "forbidden":
      return new HttpError("Forbidden", { status: 403, code: refusal.detail ?? "FORBIDDEN" })
  }
}

const EDIT_REFUSAL_CODES: Record<DocAgentEditRefusal["reason"], string> = {
  not_found: DocErrorCodes.EDIT_TEXT_NOT_FOUND,
  ambiguous: DocErrorCodes.EDIT_TEXT_AMBIGUOUS,
  unknown_block: DocErrorCodes.SECTION_NOT_FOUND,
}

function writeError(failure: Exclude<DocAgentWriteResult, { status: "applied" | "unchanged" }>): HttpError {
  switch (failure.status) {
    case "edit_refused":
      return new HttpError("An edit did not match the doc; nothing was written", {
        status: 409,
        code: EDIT_REFUSAL_CODES[failure.refusal.reason],
        details: {
          ...(failure.refusal.editIndex === undefined ? {} : { editIndex: failure.refusal.editIndex }),
          scope: failure.refusal.scope,
        },
      })
    case "invalid":
      return new HttpError("The result would not be a valid doc", { status: 400, code: DocErrorCodes.UPDATE_INVALID })
    default:
      return accessError(failure)
  }
}

function serializeDoc(doc: DocAgentDocSummary) {
  return {
    id: doc.docId,
    hostStreamId: doc.hostStreamId,
    title: doc.title,
    seq: doc.seq,
    createdAt: doc.createdAt.toISOString(),
  }
}

function serializeDocStream(doc: Stream, seq: number) {
  if (!doc.parentStreamId) throw new Error(`Doc ${doc.id} has no host stream`)
  return serializeDoc({
    docId: doc.id,
    hostStreamId: doc.parentStreamId,
    title: doc.displayName ?? null,
    seq,
    createdAt: doc.createdAt,
  })
}

/**
 * Docs on the public API: the same ops a persona's doc tools run, acting as the
 * key's principal (user keys as the owner, workspace keys as the bot), with the
 * service's refusals mapped to HTTP errors. A doc the key cannot reach is 404.
 */
export function createDocPublicApiHandlers({
  docAgentService,
  pool,
  eventService,
  streamService,
  getAccessibleStreamIds,
}: {
  docAgentService: DocAgentService
  pool: Pool
  eventService: EventService
  streamService: Pick<StreamService, "moveDoc">
  getAccessibleStreamIds: (req: Request) => Promise<string[]>
}) {
  return {
    async listDocs(req: Request, res: Response) {
      const { streamId, query, includeArchived, after, limit } = validateRequest(listDocsQuerySchema, req.query)
      const workspaceId = req.workspaceId!
      const showArchived = includeArchived === "true"
      const accessibleIds = await getAccessibleStreamIds(req)
      if (streamId && !accessibleIds.includes(streamId)) throw notFound()

      const cursor = after ? decodeCursor(after) : undefined
      const docs = await StreamRepository.listByIds(pool, workspaceId, accessibleIds, {
        types: [StreamTypes.DOC],
        parentStreamId: streamId,
        query,
        includeArchived: showArchived,
        cursorCreatedAt: cursor?.sortKey,
        cursorId: cursor?.id,
        limit: limit + 1,
      })
      const hasMore = docs.length > limit
      const page = hasMore ? docs.slice(0, limit) : docs
      const pageIds = page.map((doc) => doc.id)
      const [heads, archivedIds] = await Promise.all([
        DocRepository.listHeads(pool, workspaceId, pageIds),
        showArchived ? StreamRepository.filterEffectivelyArchivedIds(pool, workspaceId, pageIds) : Promise.resolve([]),
      ])
      const seqs = new Map(heads.map((head) => [head.streamId, head.updateSeq]))
      const archived = new Set(archivedIds)
      const last = page[page.length - 1]
      res.json({
        data: page.map((doc) => {
          const seq = seqs.get(doc.id)
          if (seq === undefined) throw new Error(`Doc ${doc.id} has no head row`)
          return {
            ...serializeDocStream(doc, seq),
            archived: archived.has(doc.id),
          }
        }),
        hasMore,
        cursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
      })
    },

    async getDoc(req: Request, res: Response) {
      const { docId } = validateRequest(docIdParamSchema, req.params)
      const read = await docAgentService.readDoc(keyContext(req, null), { docId })
      if (read.status === "not_found") throw notFound()
      res.json({ data: { ...serializeDoc(read), markdown: read.markdown } })
    },

    async createDoc(req: Request, res: Response) {
      const body = validateRequest(createDocSchema, req.body)
      const created = await docAgentService.createDoc(keyContext(req, body.streamId), {
        title: body.title,
        markdown: body.markdown,
        reason: body.reason ?? "",
      })
      if (created.status !== "created") throw accessError(created)
      if (created.body) {
        throw new HttpError("The doc was created, but its body was not applied", {
          status: created.body.status === "invalid" ? 400 : 500,
          code: DocErrorCodes.CREATE_INCOMPLETE,
          details: { docId: created.docId, failure: created.body.status },
        })
      }
      res.status(201).json({ data: { ...serializeDoc(created), markdown: created.markdown } })
    },

    async editDoc(req: Request, res: Response) {
      const { docId } = validateRequest(docIdParamSchema, req.params)
      const body = validateRequest(editDocSchema, req.body)
      const result = await docAgentService.editDoc(keyContext(req, null), {
        docId,
        reason: body.reason,
        edits: body.edits,
      })
      switch (result.status) {
        case "applied":
          return res.json({
            data: {
              id: result.docId,
              title: result.title,
              seq: result.seq,
              touchedBlockIds: result.touchedBlockIds,
              markdown: result.markdown,
            },
          })
        case "unchanged":
          return res.json({
            data: { id: result.docId, title: result.title, seq: result.seq, touchedBlockIds: [], markdown: "" },
          })
        default:
          throw writeError(result)
      }
    },

    async moveDoc(req: Request, res: Response) {
      const { docId } = validateRequest(docIdParamSchema, req.params)
      const { fromStreamId, toStreamId } = validateRequest(moveDocSchema, req.body)
      const workspaceId = req.workspaceId!
      const doc = await streamService.moveDoc({
        workspaceId,
        docId,
        fromStreamId,
        toStreamId,
        principal: apiKeyPrincipal(req),
        isWorkspaceAdmin: callerIsWorkspaceAdmin(req),
      })
      const [head] = await DocRepository.listHeads(pool, workspaceId, [doc.id])
      if (!head) throw new Error(`Doc ${doc.id} has no head row`)
      res.json({ data: serializeDocStream(doc, head.updateSeq) })
    },

    async commentOnDocSection(req: Request, res: Response) {
      const { docId, blockId } = validateRequest(docSectionParamSchema, req.params)
      const body = validateRequest(commentOnDocSectionSchema, req.body)
      const opened = await docAgentService.openSectionThread(keyContext(req, null), { docId, blockId })
      if (opened.status === "unknown_block") {
        throw new HttpError("Block not found in this doc", { status: 404, code: DocErrorCodes.SECTION_NOT_FOUND })
      }
      if (opened.status !== "ok") throw accessError(opened)
      const sent = await createMessageAsKey({ pool, eventService }, req, {
        streamId: opened.threadId,
        body: plaintextMessageBody(body.content),
        clientMessageId: body.clientMessageId,
        metadata: body.metadata,
      })
      res.status(201).json({ data: { threadId: opened.threadId, message: sent.data } })
    },
  }
}
