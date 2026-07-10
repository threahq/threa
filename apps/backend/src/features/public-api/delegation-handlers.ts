import type { Request, Response } from "express"
import type { Pool } from "pg"
import { AuthorTypes, THREA_CALLBACK_TOKEN_HEADER, sentViaApiKey } from "@threa/types"
import { HttpError } from "@threa/backend-common"
import { collectAttachmentReferenceIds, parseMarkdown } from "@threa/prosemirror"
import { withTransaction } from "../../db"
import { validateRequest } from "../../lib/validation"
import { normalizeMessage, toEmoji } from "../emoji"
import type { EventService } from "../messaging"
import type { StreamService } from "../streams"
import { listAccessibleStreamIds } from "../streams"
import { E2eStreamsRepository } from "../e2e-streams"
import type { DelegatedTask, DelegationService } from "../delegations"
import {
  claimDelegationSchema,
  completeDelegationSchema,
  failDelegationSchema,
  listDelegationsQuerySchema,
  reportDelegationStatusSchema,
} from "./schemas"

interface DelegationPublicApiDeps {
  pool: Pool
  delegationService: DelegationService
  eventService: EventService
  streamService: StreamService
}

/** Wire shape for a delegation on the public API. Claim-related secrets never appear here. */
function serializeDelegation(delegation: DelegatedTask) {
  return {
    id: delegation.id,
    streamId: delegation.streamId,
    title: delegation.title,
    status: delegation.status,
    claimedByLabel: delegation.claimedByLabel ?? undefined,
    statusNote: delegation.statusNote ?? undefined,
    resultMessageId: delegation.resultMessageId ?? undefined,
    sourceConversationId: delegation.sourceConversationId ?? undefined,
    createdAt: delegation.createdAt.toISOString(),
    statusChangedAt: delegation.statusChangedAt.toISOString(),
  }
}

/**
 * Public API for the delegation lifecycle (roadmap 5.3) — how a local agent
 * closes the loop on a `delegate_task` hand-off: list the open queue, claim
 * one, report progress, and complete with a result message or fail.
 *
 * Identity model: **user-scoped API keys only** (403 for bot keys). A
 * delegation is the key owner's own local agent acting with their credentials
 * (INV-65) — there is no bot identity in the loop, and completion posts the
 * result *as the user* with the standard `sentVia` API-key provenance, exactly
 * like public `sendMessage`. The message enters the normal pipeline, so GAM
 * memorizes the outcome.
 *
 * Claim binding: `claim` mints the token (returned once in cleartext; sha256
 * at rest via the service); every later transition authenticates with the
 * `X-Threa-Callback-Token` header — the sealed-claim pattern. A lapsed, stolen,
 * or already-terminal claim makes the token-guarded CAS match nothing → 404,
 * mirroring bot-invocation renew/complete. Claiming is CAS `open → claimed`
 * only: an `expired` delegation stays terminal (the sweep's visible transition
 * keeps its meaning) — re-claiming was considered and deliberately left out.
 */
export function createDelegationPublicApiHandlers({
  pool,
  delegationService,
  eventService,
  streamService,
}: DelegationPublicApiDeps) {
  function requireUserKey(req: Request) {
    if (!req.userApiKey || !req.user) {
      throw new HttpError("Delegations require a user-scoped API key", { status: 403, code: "FORBIDDEN" })
    }
    return { userApiKey: req.userApiKey, user: req.user }
  }

  function requireCallbackToken(req: Request): string {
    const token = req.header(THREA_CALLBACK_TOKEN_HEADER)
    if (!token) {
      throw new HttpError(`Missing ${THREA_CALLBACK_TOKEN_HEADER} header`, { status: 401, code: "UNAUTHORIZED" })
    }
    return token
  }

  return {
    /** The claimable queue, filtered to streams the key's user can access (INV-62). */
    async listDelegations(req: Request, res: Response) {
      const { user } = requireUserKey(req)
      const workspaceId = req.workspaceId!
      validateRequest(listDelegationsQuerySchema, req.query)

      const open = await delegationService.listOpen({ workspaceId })
      const accessible = await listAccessibleStreamIds(
        pool,
        workspaceId,
        user.id,
        open.map((d) => d.streamId)
      )
      res.json({ data: open.filter((d) => accessible.has(d.streamId)).map(serializeDelegation) })
    },

    /**
     * CAS `open → claimed`. Exactly one concurrent claimer wins; a lost race is
     * 409 (the delegation exists but is not open), an invisible or missing id
     * is 404. The response is the executor's full working set: the brief, the
     * context refs, and the claim token (cleartext, returned exactly once).
     */
    async claimDelegation(req: Request, res: Response) {
      const { user } = requireUserKey(req)
      const workspaceId = req.workspaceId!
      const id = req.params.delegationId!
      const { claimedByLabel } = validateRequest(claimDelegationSchema, req.body)

      const delegation = await delegationService.getById({ workspaceId, id })
      if (!delegation || !(await streamService.tryAccess(delegation.streamId, workspaceId, user.id))) {
        throw new HttpError("Delegation not found", { status: 404, code: "NOT_FOUND" })
      }

      const result = await delegationService.claim({ workspaceId, id, claimedByLabel })
      if (!result.ok) {
        if (result.reason === "not_found") {
          throw new HttpError("Delegation not found", { status: 404, code: "NOT_FOUND" })
        }
        throw new HttpError("Delegation is not open to claim", { status: 409, code: "DELEGATION_NOT_OPEN" })
      }

      res.json({
        data: {
          ...serializeDelegation(result.delegation),
          brief: result.delegation.brief,
          contextRefs: result.delegation.contextRefs,
          claimToken: result.claimToken,
          claimExpiresAt: result.delegation.claimExpiresAt!.toISOString(),
        },
      })
    },

    /** Push the claim TTL forward. Liveness only — no status change, no card event. */
    async heartbeatDelegation(req: Request, res: Response) {
      requireUserKey(req)
      const claimToken = requireCallbackToken(req)

      const claimExpiresAt = await delegationService.heartbeat({
        workspaceId: req.workspaceId!,
        id: req.params.delegationId!,
        claimToken,
      })
      if (!claimExpiresAt) {
        throw new HttpError("Delegation claim not found", { status: 404, code: "NOT_FOUND" })
      }
      res.json({ data: { claimExpiresAt: claimExpiresAt.toISOString() } })
    },

    /** Progress report: `claimed|running → running`, note lands on the card, TTL renews. */
    async reportDelegationStatus(req: Request, res: Response) {
      requireUserKey(req)
      const claimToken = requireCallbackToken(req)
      const { statusNote } = validateRequest(reportDelegationStatusSchema, req.body)

      const running = await delegationService.markRunning({
        workspaceId: req.workspaceId!,
        id: req.params.delegationId!,
        claimToken,
        statusNote,
      })
      if (!running) {
        throw new HttpError("Delegation claim not found", { status: 404, code: "NOT_FOUND" })
      }
      res.json({ data: serializeDelegation(running) })
    },

    /**
     * Terminal success. When a result is given, the message insert and the
     * `completed` CAS share one transaction, so a lost claim race (cancelled /
     * expired under us) rolls the message back instead of leaving an orphan —
     * the `completeBotInvocation` shape.
     */
    async completeDelegation(req: Request, res: Response) {
      const { user, userApiKey } = requireUserKey(req)
      const workspaceId = req.workspaceId!
      const id = req.params.delegationId!
      const claimToken = requireCallbackToken(req)
      const { resultMarkdown } = validateRequest(completeDelegationSchema, req.body)

      const delegation = await delegationService.getById({ workspaceId, id })
      if (!delegation) {
        throw new HttpError("Delegation claim not found", { status: 404, code: "NOT_FOUND" })
      }

      let contentMarkdown: string | null = null
      if (resultMarkdown) {
        // Defensive: delegations are never created on sealed streams (the tool
        // is absent there), but a plaintext write into an E2E stream would
        // break the sealed timeline — fail before any insert.
        if (await E2eStreamsRepository.isE2eStream(pool, workspaceId, delegation.streamId)) {
          throw new HttpError("Stream is end-to-end encrypted; the public API cannot post plaintext to it", {
            status: 400,
            code: "E2E_STREAM_PLAINTEXT_UNSUPPORTED",
          })
        }
        contentMarkdown = normalizeMessage(resultMarkdown)
      }
      const contentJson = contentMarkdown ? parseMarkdown(contentMarkdown, undefined, toEmoji) : null
      const attachmentIds = contentJson ? collectAttachmentReferenceIds(contentJson) : []

      const { completed, resultMessageId } = await withTransaction(pool, async (client) => {
        let resultMessageId: string | undefined
        if (contentMarkdown && contentJson) {
          const { message } = await eventService.createMessageInTransaction(client, {
            workspaceId,
            streamId: delegation.streamId,
            authorId: user.id,
            authorType: AuthorTypes.USER,
            contentJson,
            contentMarkdown,
            attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
            clientMessageId: `delegation:${delegation.id}`,
            sentVia: sentViaApiKey(userApiKey.id),
          })
          resultMessageId = message.id
        }
        const completed = await delegationService.completeInTransaction(client, {
          workspaceId,
          id,
          claimToken,
          resultMessageId,
        })
        if (!completed) {
          throw new HttpError("Delegation claim not found", { status: 404, code: "NOT_FOUND" })
        }
        return { completed, resultMessageId }
      })

      res.json({ data: { ...serializeDelegation(completed), resultMessageId } })
    },

    /** Terminal failure: records why on the card. */
    async failDelegation(req: Request, res: Response) {
      requireUserKey(req)
      const claimToken = requireCallbackToken(req)
      const { errorMessage } = validateRequest(failDelegationSchema, req.body)

      const failed = await delegationService.fail({
        workspaceId: req.workspaceId!,
        id: req.params.delegationId!,
        claimToken,
        statusNote: errorMessage,
      })
      if (!failed) {
        throw new HttpError("Delegation claim not found", { status: 404, code: "NOT_FOUND" })
      }
      res.json({ data: serializeDelegation(failed) })
    },
  }
}
