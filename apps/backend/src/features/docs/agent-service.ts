import type { Pool } from "pg"
import {
  AuthorTypes,
  DocErrorCodes,
  StreamErrorCodes,
  StreamReadOnlyReasons,
  StreamTypes,
  type AuthorType,
  type StreamReadOnlyReason,
} from "@threahq/types"
import { HttpError, StreamNotFoundError } from "../../lib/errors"
import { blockId } from "../../lib/id"
import { logger } from "../../lib/logger"
import type { BotChannelService } from "../api-keys"
import {
  StreamRepository,
  checkStreamAccess,
  type Stream,
  type StreamService,
  type StreamWritePrincipal,
} from "../streams"
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
  DocAgentListResult,
  DocAgentReadResult,
  DocAgentRefusalCode,
  DocAgentTitleResult,
  DocAgentWriteResult,
} from "./agent-types"
import { DocRepository } from "./repository"
import type { DocService } from "./service"

/**
 * Who a doc op acts as: authorized as `principal`, attributed to `actor`, and
 * confined to `hostStreamId`'s docs when set (null reaches any doc the principal can read).
 */
export interface DocAgentContext {
  workspaceId: string
  hostStreamId: string | null
  principal: StreamWritePrincipal
  actor: { actorId: string; actorType: AuthorType }
}

/** A persona turn: authorized as `invokingUserId`, attributed to `personaId`, confined to `hostStreamId`'s docs. */
export interface DocAgentTurn {
  workspaceId: string
  hostStreamId: string
  invokingUserId: string
  personaId: string
}

/** Listing and creating need a host; reads and writes by id do not. */
export type HostedDocAgentContext = DocAgentContext & { hostStreamId: string }

const READ_ONLY_REFUSALS: Partial<Record<StreamReadOnlyReason, DocAgentRefusalCode>> = {
  [StreamReadOnlyReasons.ARCHIVED]: "archived",
  [StreamReadOnlyReasons.NOT_A_MEMBER]: "not_a_member",
}

function refusalFor(error: HttpError): DocAgentAccessRefusal {
  switch (error.code) {
    case StreamErrorCodes.READ_ONLY: {
      const reason = (error.details as { reason?: StreamReadOnlyReason } | undefined)?.reason
      return {
        status: "refused",
        code: (reason && READ_ONLY_REFUSALS[reason]) ?? "read_only",
        ...(reason ? { reason } : {}),
      }
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

function summarize(doc: Stream, hostStreamId: string, seq: number): DocAgentDocSummary {
  return { docId: doc.id, hostStreamId, title: doc.displayName ?? null, seq, createdAt: doc.createdAt }
}

export class DocAgentService {
  private pool: Pool
  private docService: DocService
  private streamService: StreamService
  private botChannelService: BotChannelService

  constructor(deps: {
    pool: Pool
    docService: DocService
    streamService: StreamService
    botChannelService: BotChannelService
  }) {
    this.pool = deps.pool
    this.docService = deps.docService
    this.streamService = deps.streamService
    this.botChannelService = deps.botChannelService
  }

  /** The doc ops bound to one turn's context; the doc tools take this as their deps. */
  forTurn(turn: DocAgentTurn) {
    const ctx: HostedDocAgentContext = {
      workspaceId: turn.workspaceId,
      hostStreamId: turn.hostStreamId,
      principal: { kind: "user", userId: turn.invokingUserId },
      actor: { actorId: turn.personaId, actorType: AuthorTypes.PERSONA },
    }
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

  /** The host's active docs, newest first; `not_found` when the principal cannot read the host. */
  async listDocs(ctx: HostedDocAgentContext): Promise<DocAgentListResult> {
    if (!(await this.canRead(ctx, ctx.hostStreamId))) return { status: "not_found" }
    const docs = await StreamRepository.list(this.pool, ctx.workspaceId, {
      types: [StreamTypes.DOC],
      parentStreamId: ctx.hostStreamId,
      archiveStatus: ["active"],
    })
    const heads = await DocRepository.listHeads(
      this.pool,
      ctx.workspaceId,
      docs.map((doc) => doc.id)
    )
    const seqs = new Map(heads.map((head) => [head.streamId, head.updateSeq]))
    return {
      status: "ok",
      docs: docs.map((doc) => {
        const seq = seqs.get(doc.id)
        if (seq === undefined) throw new Error(`Doc ${doc.id} has no head row`)
        return summarize(doc, ctx.hostStreamId, seq)
      }),
    }
  }

  async readDoc(ctx: DocAgentContext, input: { docId: string }): Promise<DocAgentReadResult> {
    const doc = await this.accessibleDoc(ctx, input.docId)
    if (!doc || doc.archivedAt) return { status: "not_found" }
    const head = await DocRepository.findHead(this.pool, ctx.workspaceId, doc.id)
    if (!head) throw new Error(`Doc ${doc.id} has no head row`)
    const sections = await DocRepository.listSections(this.pool, ctx.workspaceId, doc.id)
    return {
      status: "ok",
      ...summarize(doc, doc.parentStreamId, head.updateSeq),
      markdown: renderWithMarkers(sections),
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
        { workspaceId: ctx.workspaceId, principal: ctx.principal }
      )
      return { status: "applied", docId: input.docId, title }
    })
  }

  /** The title commits with the doc row (blank leaves it untitled); the body lands as the actor's first write after it. */
  async createDoc(
    ctx: HostedDocAgentContext,
    input: { reason: string; title?: string; markdown?: string }
  ): Promise<DocAgentCreateResult> {
    const created = await orRefusal(() =>
      this.streamService.createDoc({
        workspaceId: ctx.workspaceId,
        parentStreamId: ctx.hostStreamId,
        principal: ctx.principal,
        displayName: input.title?.trim() || undefined,
      })
    )
    if ("status" in created) return created
    const docId = created.id
    const result: Extract<DocAgentCreateResult, { status: "created" }> = {
      status: "created",
      ...summarize(created, ctx.hostStreamId, 0),
      markdown: "",
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
        principal: ctx.principal,
        actor: ctx.actor,
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

  private async hostedDocRefusal(ctx: DocAgentContext, docId: string): Promise<DocAgentAccessRefusal | null> {
    const doc = await this.accessibleDoc(ctx, docId)
    if (!doc) return { status: "not_found" }
    if (doc.archivedAt) return { status: "refused", code: "archived", reason: StreamReadOnlyReasons.ARCHIVED }
    return null
  }

  /**
   * The doc when this context may read it: under the host when confined, and reachable by the principal.
   * Parentage never changes after creation, so this needs no lock; a write's own lock rechecks archive state.
   */
  private async accessibleDoc(
    ctx: DocAgentContext,
    docId: string
  ): Promise<(Stream & { parentStreamId: string }) | null> {
    const stream = await StreamRepository.findById(this.pool, ctx.workspaceId, docId)
    if (stream?.type !== StreamTypes.DOC || !stream.parentStreamId) return null
    if (ctx.hostStreamId !== null && stream.parentStreamId !== ctx.hostStreamId) return null
    if (!(await this.canRead(ctx, stream.id))) return null
    return { ...stream, parentStreamId: stream.parentStreamId }
  }

  private async canRead(ctx: DocAgentContext, streamId: string): Promise<boolean> {
    const { principal } = ctx
    if (principal.kind === "user") {
      return (await checkStreamAccess(this.pool, streamId, ctx.workspaceId, principal.userId)) !== null
    }
    return this.botChannelService.isStreamAccessibleForBot(ctx.workspaceId, principal.botId, streamId)
  }
}
