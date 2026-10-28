import type { Pool } from "pg"
import {
  AuthorTypes,
  DocErrorCodes,
  StreamErrorCodes,
  StreamReadOnlyReasons,
  StreamTypes,
  type StreamReadOnlyReason,
} from "@threahq/types"
import { HttpError, StreamNotFoundError } from "../../lib/errors"
import { blockId } from "../../lib/id"
import { logger } from "../../lib/logger"
import { StreamRepository, checkStreamAccess, type StreamService } from "../streams"
import {
  deleteSection,
  insertSection,
  moveSection,
  renderWithMarkers,
  resolveEdits,
  type AgentSection,
  type DocAgentEdit,
  type DocRewrite,
} from "./agent-markdown"
import type {
  DocAgentAccessRefusal,
  DocAgentCreateResult,
  DocAgentDocSummary,
  DocAgentReadResult,
  DocAgentRefusalCode,
  DocAgentTitleResult,
  DocAgentWriteResult,
} from "./agent-types"
import type { DocService } from "./service"

/** Who an agent turn acts as: authorized as `invokingUserId`, attributed to `personaId`, confined to `hostStreamId`'s docs. */
export interface DocAgentContext {
  workspaceId: string
  hostStreamId: string
  invokingUserId: string
  personaId: string
}

const READ_ONLY_REFUSALS: Partial<Record<StreamReadOnlyReason, DocAgentRefusalCode>> = {
  [StreamReadOnlyReasons.ARCHIVED]: "archived",
  [StreamReadOnlyReasons.NOT_A_MEMBER]: "not_a_member",
}

function refusalFor(error: HttpError): DocAgentAccessRefusal {
  switch (error.code) {
    case StreamErrorCodes.READ_ONLY: {
      const reason = (error.details as { reason?: StreamReadOnlyReason } | undefined)?.reason
      return { status: "refused", code: (reason && READ_ONLY_REFUSALS[reason]) ?? "read_only" }
    }
    case StreamErrorCodes.CHANNEL_MANAGEMENT_FORBIDDEN:
      return { status: "refused", code: "forbidden" }
    case DocErrorCodes.HOST_TYPE_INVALID:
      return { status: "refused", code: "host_cannot_host_docs" }
    case DocErrorCodes.E2E_HOST_NOT_ALLOWED:
      return { status: "refused", code: "e2e_host" }
    default:
      return { status: "refused", code: "forbidden", ...(error.code ? { detail: error.code } : {}) }
  }
}

/** Access failures come back as results, not HttpErrors, so a tool can hand them to the model. */
async function orRefusal<T>(run: () => Promise<T>): Promise<T | DocAgentAccessRefusal> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof StreamNotFoundError) return { status: "not_found" }
    if (error instanceof HttpError && error.status < 500) return refusalFor(error)
    throw error
  }
}

/** For a step after a doc exists: a throw is logged and reported, so the caller can still return the doc's id. */
async function orLoggedError<T>(
  log: { docId: string; step: string },
  run: () => Promise<T>
): Promise<T | { status: "error" }> {
  try {
    return await run()
  } catch (error) {
    logger.error({ error, ...log }, "Doc agent step failed after the doc was created")
    return { status: "error" }
  }
}

export class DocAgentService {
  private pool: Pool
  private docService: DocService
  private streamService: StreamService

  constructor(deps: { pool: Pool; docService: DocService; streamService: StreamService }) {
    this.pool = deps.pool
    this.docService = deps.docService
    this.streamService = deps.streamService
  }

  /** The doc ops bound to one turn's context; the doc tools take this as their deps. */
  forTurn(ctx: DocAgentContext) {
    return {
      listDocs: () => this.listDocs(ctx),
      readDoc: (input: { docId: string }) => this.readDoc(ctx, input),
      editDoc: (input: { docId: string; reason: string; edits: DocAgentEdit[] }) => this.editDoc(ctx, input),
      insertBlock: (input: { docId: string; reason: string; after: string; markdown: string }) =>
        this.insertBlock(ctx, input),
      moveBlock: (input: { docId: string; reason: string; blockId: string; after: string }) =>
        this.moveBlock(ctx, input),
      deleteBlock: (input: { docId: string; reason: string; blockId: string }) => this.deleteBlock(ctx, input),
      setTitle: (input: { docId: string; title: string }) => this.setTitle(ctx, input),
      createDoc: (input: { reason: string; title?: string; markdown?: string }) => this.createDoc(ctx, input),
    }
  }

  async listDocs(ctx: DocAgentContext): Promise<DocAgentDocSummary[]> {
    const host = await checkStreamAccess(this.pool, ctx.hostStreamId, ctx.workspaceId, ctx.invokingUserId)
    if (!host) return []
    const docs = await StreamRepository.list(this.pool, ctx.workspaceId, {
      types: [StreamTypes.DOC],
      parentStreamId: ctx.hostStreamId,
      archiveStatus: ["active"],
    })
    return docs.map((doc) => ({ docId: doc.id, title: doc.displayName ?? null }))
  }

  async readDoc(ctx: DocAgentContext, input: { docId: string }): Promise<DocAgentReadResult> {
    if (await this.hostedDocRefusal(ctx, input.docId)) return { status: "not_found" }
    const result = await orRefusal(() =>
      this.docService.get({ workspaceId: ctx.workspaceId, userId: ctx.invokingUserId, docId: input.docId })
    )
    if ("status" in result) return { status: "not_found" }
    return {
      status: "ok",
      docId: input.docId,
      title: result.stream.displayName ?? null,
      seq: result.seq,
      markdown: renderWithMarkers(result.sections),
    }
  }

  editDoc(
    ctx: DocAgentContext,
    input: { docId: string; reason: string; edits: DocAgentEdit[] }
  ): Promise<DocAgentWriteResult> {
    return this.write(ctx, input.docId, input.reason, (sections) => resolveEdits(sections, input.edits))
  }

  insertBlock(
    ctx: DocAgentContext,
    input: { docId: string; reason: string; after: string; markdown: string }
  ): Promise<DocAgentWriteResult> {
    return this.write(ctx, input.docId, input.reason, (sections) => insertSection(sections, input, blockId))
  }

  moveBlock(
    ctx: DocAgentContext,
    input: { docId: string; reason: string; blockId: string; after: string }
  ): Promise<DocAgentWriteResult> {
    return this.write(ctx, input.docId, input.reason, (sections) => moveSection(sections, input), {
      showBlockIds: [input.blockId],
    })
  }

  deleteBlock(
    ctx: DocAgentContext,
    input: { docId: string; reason: string; blockId: string }
  ): Promise<DocAgentWriteResult> {
    return this.write(ctx, input.docId, input.reason, (sections) => deleteSection(sections, input))
  }

  async setTitle(ctx: DocAgentContext, input: { docId: string; title: string }): Promise<DocAgentTitleResult> {
    const title = input.title.trim()
    if (!title) return { status: "refused", code: "title_empty" }
    const refusal = await this.hostedDocRefusal(ctx, input.docId)
    if (refusal) return refusal
    return orRefusal(async (): Promise<DocAgentTitleResult> => {
      await this.streamService.updateStream(
        input.docId,
        { displayName: title },
        { workspaceId: ctx.workspaceId, principal: { kind: "user", userId: ctx.invokingUserId } }
      )
      return { status: "applied", docId: input.docId, title }
    })
  }

  /**
   * Title and body are separate commits after the doc exists, the body landing
   * as the persona's first write. A blank title leaves the doc untitled.
   */
  async createDoc(
    ctx: DocAgentContext,
    input: { reason: string; title?: string; markdown?: string }
  ): Promise<DocAgentCreateResult> {
    const created = await orRefusal(() =>
      this.streamService.createDoc({
        workspaceId: ctx.workspaceId,
        parentStreamId: ctx.hostStreamId,
        createdBy: ctx.invokingUserId,
      })
    )
    if ("status" in created) return created
    const docId = created.id

    const requestedTitle = input.title?.trim()
    const titled = requestedTitle
      ? await orLoggedError({ docId, step: "title" }, () => this.setTitle(ctx, { docId, title: requestedTitle }))
      : null
    const result: Extract<DocAgentCreateResult, { status: "created" }> = {
      status: "created",
      docId,
      title: titled?.status === "applied" ? titled.title : null,
      seq: 0,
      markdown: "",
      ...(titled && titled.status !== "applied" ? { titleFailure: titled } : {}),
    }

    const markdown = input.markdown
    if (!markdown?.trim()) return result
    const body = await orLoggedError({ docId, step: "body" }, () =>
      this.write(ctx, docId, input.reason, (sections) => insertSection(sections, { after: "start", markdown }, blockId))
    )
    switch (body.status) {
      case "applied":
        return { ...result, seq: body.seq, markdown: body.markdown }
      case "unchanged":
        return { ...result, seq: body.seq }
      default:
        return { ...result, body }
    }
  }

  private async write(
    ctx: DocAgentContext,
    docId: string,
    reason: string,
    rewrite: (sections: AgentSection[]) => DocRewrite,
    options: { showBlockIds?: string[] } = {}
  ): Promise<DocAgentWriteResult> {
    const refusal = await this.hostedDocRefusal(ctx, docId)
    if (refusal) return refusal
    return orRefusal(async (): Promise<DocAgentWriteResult> => {
      const result = await this.docService.applyAgentRewrite({
        workspaceId: ctx.workspaceId,
        docId,
        invokingUserId: ctx.invokingUserId,
        actor: { actorId: ctx.personaId, actorType: AuthorTypes.PERSONA },
        reason,
        rewrite,
      })
      switch (result.status) {
        case "applied": {
          const shown = new Set([...result.touchedBlockIds, ...(options.showBlockIds ?? [])])
          return {
            status: "applied",
            docId,
            title: result.title,
            seq: result.seq,
            touchedBlockIds: result.touchedBlockIds,
            markdown: renderWithMarkers(result.sections.filter((section) => shown.has(section.blockId))),
          }
        }
        case "unchanged":
          return { status: "unchanged", docId, title: result.title, seq: result.seq }
        default:
          return result
      }
    })
  }

  /** Parentage never changes after creation, so this check needs no lock; the write's own lock rechecks archive state. */
  private async hostedDocRefusal(ctx: DocAgentContext, docId: string): Promise<DocAgentAccessRefusal | null> {
    const stream = await StreamRepository.findById(this.pool, ctx.workspaceId, docId)
    if (stream?.type !== StreamTypes.DOC || stream.parentStreamId !== ctx.hostStreamId) return { status: "not_found" }
    if (stream.archivedAt) return { status: "refused", code: "archived" }
    return null
  }
}
