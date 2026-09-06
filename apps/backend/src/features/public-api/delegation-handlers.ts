import type { Request, Response } from "express"
import type { Pool } from "pg"
import type { PoolClient } from "pg"
import {
  AuthorTypes,
  DelegationStatuses,
  THREA_CALLBACK_TOKEN_HEADER,
  sentViaApiKey,
  type AuthorType,
} from "@threahq/types"
import { HttpError } from "@threahq/backend-common"
import { collectAttachmentReferenceIds, parseMarkdown } from "@threahq/prosemirror"
import { withTransaction } from "../../db"
import { validateRequest } from "../../lib/validation"
import { normalizeMessage, toEmoji } from "../emoji"
import { MessageRepository, type EventService } from "../messaging"
import type { StreamService, StreamWritePrincipal } from "../streams"
import { assertStreamWritable, listAccessibleStreamIds, StreamRepository } from "../streams"
import { E2eStreamsRepository } from "../e2e-streams"
import type { BotChannelService } from "../api-keys"
import { hashCallbackToken } from "../agents"
import { BotRepository } from "./bot-repository"
import type { DelegatedTask, DelegationService } from "../delegations"
import type { BotAccessRequestService } from "../bot-access-requests"
import {
  claimDelegationSchema,
  completeDelegationSchema,
  failDelegationSchema,
  listDelegationsQuerySchema,
  reportDelegationStatusSchema,
  requestDelegationAccessSchema,
} from "./schemas"

interface DelegationPublicApiDeps {
  pool: Pool
  delegationService: DelegationService
  eventService: EventService
  streamService: StreamService
  botChannelService: BotChannelService
  botAccessRequestService: BotAccessRequestService
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
 * Public API for the delegation lifecycle (roadmap 5.3) — how an agent closes
 * the loop on a `delegate_task` hand-off: list the open queue, claim one,
 * report progress, and complete with a result message or fail.
 *
 * Identity model mirrors public `sendMessage`, two branches per key kind:
 * a user-scoped key is the key owner's own local agent (INV-65) — the result
 * message is authored as the user with `sentVia` API-key provenance; a
 * workspace (bot) key is a shared runner — the result is authored as the bot
 * entity. Access is symmetrical: user keys see streams the user can access,
 * bot keys see the bot's channel grants. Either way the message enters the
 * normal pipeline, so GAM memorizes the outcome.
 *
 * Claim binding: `claim` mints the token (returned once in cleartext; sha256
 * at rest via the service); every later transition authenticates with the
 * `X-Threa-Callback-Token` header — the sealed-claim pattern. A lapsed, stolen,
 * or already-terminal claim makes the token-guarded CAS match nothing → 404,
 * mirroring bot-invocation renew/complete. Direct claiming CASes either `open`
 * or a historical `expired` row to `claimed`; queue listing remains open-only.
 */
export function createDelegationPublicApiHandlers({
  pool,
  delegationService,
  eventService,
  streamService,
  botChannelService,
  botAccessRequestService,
}: DelegationPublicApiDeps) {
  type KeyIdentity =
    | { kind: "user"; userId: string; userName: string; apiKeyId: string }
    | { kind: "bot"; botId: string }

  function resolveKeyIdentity(req: Request): KeyIdentity {
    if (req.userApiKey && req.user) {
      return { kind: "user", userId: req.user.id, userName: req.user.name, apiKeyId: req.userApiKey.id }
    }
    if (req.botApiKey) {
      return { kind: "bot", botId: req.botApiKey.botId }
    }
    throw new HttpError("No API key context", { status: 401, code: "UNAUTHORIZED" })
  }

  /**
   * Delegations are a participation surface — claiming one puts the bot's name
   * on a card other members see, and completing it writes terminal state — so
   * bot keys gate on the consent-gated ACTIONABLE set (public ∪ grants), never
   * the read-as-owner-widened one. A reads-as-owner bot that merely reads a
   * stream must not claim work there, and `requestDelegationAccess`'s
   * already-granted short-circuit must keep meaning "a grant exists".
   */
  async function streamAccessibleFor(identity: KeyIdentity, workspaceId: string, streamId: string): Promise<boolean> {
    if (identity.kind === "user") {
      return (await streamService.tryAccess(streamId, workspaceId, identity.userId)) !== null
    }
    return botChannelService.isStreamActionableForBot(workspaceId, identity.botId, streamId)
  }

  /**
   * Load a delegation the key may act on, or 404. Every lifecycle op gates on
   * CURRENT stream access, not just claim time: a key that loses access
   * mid-claim (revoked channel grant, removed member) can no longer drive the
   * card — its status notes stop landing and its lapsed claim reopens instead
   * of renewing a zombie it can never finish.
   * 404 (not 403) so a non-member probing ids can't tell an existing
   * delegation from a missing one, mirroring the first-party cancel handler.
   */
  async function resolveAccessibleDelegation(
    identity: KeyIdentity,
    workspaceId: string,
    id: string
  ): Promise<DelegatedTask> {
    const delegation = await delegationService.getById({ workspaceId, id })
    if (!delegation || !(await streamAccessibleFor(identity, workspaceId, delegation.streamId))) {
      throw new HttpError("Delegation not found", { status: 404, code: "NOT_FOUND" })
    }
    return delegation
  }

  function requireCallbackToken(req: Request): string {
    const token = req.header(THREA_CALLBACK_TOKEN_HEADER)
    if (!token) {
      throw new HttpError(`Missing ${THREA_CALLBACK_TOKEN_HEADER} header`, { status: 401, code: "UNAUTHORIZED" })
    }
    return token
  }

  async function findResultThreadId(delegation: DelegatedTask): Promise<string | undefined> {
    if (!delegation.resultMessageId) return undefined
    const resultMessage = await MessageRepository.findById(pool, delegation.resultMessageId)
    if (resultMessage && resultMessage.streamId !== delegation.streamId) return resultMessage.streamId
    return (await StreamRepository.findByAnchor(pool, delegation.streamId, delegation.resultMessageId))?.id
  }

  return {
    /** The claimable queue, filtered to streams the key's identity can access (INV-62 / channel grants). */
    async listDelegations(req: Request, res: Response) {
      const identity = resolveKeyIdentity(req)
      const workspaceId = req.workspaceId!
      const { since } = validateRequest(listDelegationsQuerySchema, req.query)

      const open = await delegationService.listOpen({ workspaceId, since: since ? new Date(since) : undefined })
      const accessible =
        identity.kind === "user"
          ? await listAccessibleStreamIds(
              pool,
              workspaceId,
              identity.userId,
              open.map((d) => d.streamId)
            )
          : new Set(await botChannelService.getActionableStreamIdsForBot(workspaceId, identity.botId))
      res.json({ data: open.filter((d) => accessible.has(d.streamId)).map(serializeDelegation) })
    },

    async getDelegation(req: Request, res: Response) {
      const identity = resolveKeyIdentity(req)
      const delegation = await resolveAccessibleDelegation(identity, req.workspaceId!, req.params.delegationId!)
      res.json({
        data: {
          ...serializeDelegation(delegation),
          brief: delegation.brief,
          contextRefs: delegation.contextRefs,
          claimExpiresAt: delegation.claimExpiresAt?.toISOString(),
        },
      })
    },

    /**
     * CAS `open|expired → claimed`. Exactly one concurrent claimer wins; a lost race is
     * 409 (the delegation exists but is not open), an invisible or missing id
     * is 404. The response is the executor's full working set: the brief, the
     * context refs, and the claim token (cleartext, returned exactly once).
     */
    async claimDelegation(req: Request, res: Response) {
      const identity = resolveKeyIdentity(req)
      const workspaceId = req.workspaceId!
      const id = req.params.delegationId!
      const { claimedByLabel, idempotencyKey } = validateRequest(claimDelegationSchema, req.body)

      await resolveAccessibleDelegation(identity, workspaceId, id)

      const result = await delegationService.claim({ workspaceId, id, claimedByLabel, idempotencyKey })
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

    async releaseDelegation(req: Request, res: Response) {
      const identity = resolveKeyIdentity(req)
      const claimToken = requireCallbackToken(req)
      await resolveAccessibleDelegation(identity, req.workspaceId!, req.params.delegationId!)
      const reopened = await delegationService.release({
        workspaceId: req.workspaceId!,
        id: req.params.delegationId!,
        claimToken,
      })
      if (!reopened) throw new HttpError("Delegation claim not found", { status: 404, code: "NOT_FOUND" })
      res.json({ data: serializeDelegation(reopened) })
    },

    /** Push the claim TTL forward. Liveness only — no status change, no card event. */
    async heartbeatDelegation(req: Request, res: Response) {
      const identity = resolveKeyIdentity(req)
      const claimToken = requireCallbackToken(req)
      await resolveAccessibleDelegation(identity, req.workspaceId!, req.params.delegationId!)

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
      const identity = resolveKeyIdentity(req)
      const claimToken = requireCallbackToken(req)
      const { statusNote } = validateRequest(reportDelegationStatusSchema, req.body)
      await resolveAccessibleDelegation(identity, req.workspaceId!, req.params.delegationId!)

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
     * reopened under us) rolls the message back instead of leaving an orphan —
     * the `completeBotInvocation` shape. The author follows the key kind:
     * user key → the user (with via-API provenance), bot key → the bot.
     */
    async completeDelegation(req: Request, res: Response) {
      const identity = resolveKeyIdentity(req)
      const workspaceId = req.workspaceId!
      const id = req.params.delegationId!
      const claimToken = requireCallbackToken(req)
      const { resultMarkdown, metadata } = validateRequest(completeDelegationSchema, req.body)

      const delegation = await resolveAccessibleDelegation(identity, workspaceId, id)

      // Idempotent retry: a completion can commit and then lose its response
      // in transit. The terminal row keeps the claim token hash, so a retry
      // bearing the same token gets the committed outcome back instead of a
      // false 404 it has no other endpoint to disambiguate.
      if (
        delegation.status === DelegationStatuses.COMPLETED &&
        delegation.claimTokenHash === hashCallbackToken(claimToken)
      ) {
        res.json({
          data: {
            ...serializeDelegation(delegation),
            resultMessageId: delegation.resultMessageId ?? undefined,
            resultThreadId: await findResultThreadId(delegation),
          },
        })
        return
      }

      const principal: StreamWritePrincipal =
        identity.kind === "user" ? { kind: "user", userId: identity.userId } : { kind: "bot", botId: identity.botId }
      let author: { authorId: string; authorType: AuthorType; sentVia?: string } | null = null
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
        if (identity.kind === "user") {
          author = {
            authorId: identity.userId,
            authorType: AuthorTypes.USER,
            sentVia: sentViaApiKey(identity.apiKeyId),
          }
        } else {
          const bot = await BotRepository.findById(pool, workspaceId, identity.botId)
          if (!bot || bot.archivedAt) {
            throw new HttpError("Bot not found or archived", { status: 404, code: "NOT_FOUND" })
          }
          author = { authorId: bot.id, authorType: AuthorTypes.BOT }
        }
      }
      const contentMarkdown = resultMarkdown ? normalizeMessage(resultMarkdown) : null
      const contentJson = contentMarkdown ? parseMarkdown(contentMarkdown, undefined, toEmoji) : null
      const attachmentIds = contentJson ? collectAttachmentReferenceIds(contentJson) : []
      const useLegacyResultAnchor = req.apiVersion === "2026-07-12"
      const anchorMarkdown =
        useLegacyResultAnchor && contentMarkdown
          ? normalizeMessage(`✓ Completed: **${delegation.title}**. Result in thread.`)
          : null
      const anchorJson = anchorMarkdown ? parseMarkdown(anchorMarkdown, undefined, toEmoji) : null

      const { completed, resultMessageId, resultThreadId } = await withTransaction(pool, async (client: PoolClient) => {
        if (contentMarkdown) {
          await assertStreamWritable(client, {
            workspaceId,
            streamId: delegation.streamId,
            principal,
          })
        }
        // Validate the claim BEFORE any write (FOR UPDATE, token-guarded): an
        // invalid or lapsed token does no work, and the row lock serializes
        // complete-vs-cancel — the findActiveClaimForUpdate shape.
        const claim = await delegationService.findClaimedForUpdate(client, { workspaceId, id, claimToken })
        if (!claim) {
          throw new HttpError("Delegation claim not found", { status: 404, code: "NOT_FOUND" })
        }
        let resultMessageId: string | undefined
        let resultThreadId: string | undefined
        let threadStreamId: string | undefined
        if (contentMarkdown && contentJson && author) {
          let threadAnchorId: string
          if (useLegacyResultAnchor && anchorMarkdown && anchorJson) {
            // Preserve the 2026-07-12 contract: resultMessageId names the compact
            // message in the delegation stream, whose child thread holds the result.
            const { message: anchor } = await eventService.createMessageForPrincipalInTransaction(client, principal, {
              workspaceId,
              streamId: delegation.streamId,
              authorId: author.authorId,
              authorType: author.authorType,
              contentJson: anchorJson,
              contentMarkdown: anchorMarkdown,
              clientMessageId: `delegation:${delegation.id}`,
              sentVia: author.sentVia,
            })
            threadAnchorId = anchor.id
            resultMessageId = anchor.id
          } else {
            // Current contract: the delegation card is the anchor and
            // resultMessageId names the full result inside that card's thread.
            const createdEventId = await delegationService.findCreatedEventId(client, { workspaceId, id })
            if (!createdEventId) {
              throw new HttpError("Delegation card event not found", {
                status: 500,
                code: "DELEGATION_EVENT_MISSING",
              })
            }
            threadAnchorId = createdEventId
          }

          const thread = await streamService.createThreadForPrincipalOn(client, principal, {
            workspaceId,
            parentStreamId: delegation.streamId,
            parentAnchorId: threadAnchorId,
            createdBy: author.authorId,
            createdByType: author.authorType === AuthorTypes.BOT ? "bot" : "user",
          })
          const { message: result } = await eventService.createMessageForPrincipalInTransaction(client, principal, {
            workspaceId,
            streamId: thread.id,
            authorId: author.authorId,
            authorType: author.authorType,
            contentJson,
            contentMarkdown,
            attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
            clientMessageId: `delegation:${delegation.id}:result`,
            sentVia: author.sentVia,
            metadata,
          })
          resultThreadId = thread.id
          if (!useLegacyResultAnchor) {
            resultMessageId = result.id
            threadStreamId = thread.id
          }
        }
        const completed = await delegationService.completeInTransaction(client, {
          workspaceId,
          id,
          claimToken,
          resultMessageId,
          threadStreamId,
        })
        if (!completed) {
          throw new HttpError("Delegation claim not found", { status: 404, code: "NOT_FOUND" })
        }
        return { completed, resultMessageId, resultThreadId }
      })

      res.json({ data: { ...serializeDelegation(completed), resultMessageId, resultThreadId } })
    },

    /** Terminal failure: records why on the card. */
    async failDelegation(req: Request, res: Response) {
      const identity = resolveKeyIdentity(req)
      const claimToken = requireCallbackToken(req)
      const { errorMessage } = validateRequest(failDelegationSchema, req.body)
      await resolveAccessibleDelegation(identity, req.workspaceId!, req.params.delegationId!)

      const failed = await delegationService.fail({
        workspaceId: req.workspaceId!,
        id: req.params.delegationId!,
        claimToken,
        statusNote: errorMessage,
      })
      if (!failed) {
        // Same lost-response retry story as complete: a fail that already
        // committed answers the retry with its outcome, not a false 404.
        const existing = await delegationService.getById({
          workspaceId: req.workspaceId!,
          id: req.params.delegationId!,
        })
        if (
          existing?.status === DelegationStatuses.FAILED &&
          existing.claimTokenHash === hashCallbackToken(claimToken)
        ) {
          res.json({ data: serializeDelegation(existing) })
          return
        }
        throw new HttpError("Delegation claim not found", { status: 404, code: "NOT_FOUND" })
      }
      res.json({ data: serializeDelegation(failed) })
    },

    /**
     * File an access request for a delegation the bot runtime learned of via the
     * workspace-wide `delegation:available` nudge but cannot claim (no stream
     * grant). Bot keys only — a user key's access follows its user, so it is
     * pointed at joining the stream instead (400). Unlike the lifecycle ops,
     * this deliberately does NOT gate on current access: it must find the
     * delegation even when the bot LACKS access (the whole point). An unknown id
     * still 404s — the existence-hiding carve-out is scoped to ids the workspace
     * bot plane already saw broadcast on the nudge. When the bot already has
     * access, short-circuit with `already_granted` and file no card; otherwise
     * the request is idempotent per (bot, stream) — a re-request returns the same
     * open row without spawning a duplicate card.
     */
    async requestDelegationAccess(req: Request, res: Response) {
      const identity = resolveKeyIdentity(req)
      if (identity.kind === "user") {
        throw new HttpError("A user key's access follows the user; ask the user to join the stream", {
          status: 400,
          code: "USER_KEY_CANNOT_REQUEST_ACCESS",
        })
      }
      const workspaceId = req.workspaceId!
      const id = req.params.delegationId!
      const { requestedByLabel } = validateRequest(requestDelegationAccessSchema, req.body)

      const delegation = await delegationService.getById({ workspaceId, id })
      if (!delegation) {
        throw new HttpError("Delegation not found", { status: 404, code: "NOT_FOUND" })
      }
      if (await botChannelService.isStreamActionableForBot(workspaceId, identity.botId, delegation.streamId)) {
        res.json({ data: { status: "already_granted" } })
        return
      }

      // Snapshot the bot name from the roster: the card is roster-independent
      // (non-members cannot resolve an ungranted personal bot), so the name must
      // ride the request row and event payload.
      const bot = await BotRepository.findById(pool, workspaceId, identity.botId)
      if (!bot || bot.archivedAt) {
        throw new HttpError("Bot not found or archived", { status: 404, code: "NOT_FOUND" })
      }

      const { request } = await botAccessRequestService.request({
        workspaceId,
        streamId: delegation.streamId,
        botId: identity.botId,
        botName: bot.name,
        delegationId: delegation.id,
        delegationTitle: delegation.title,
        requestedByLabel,
      })
      res.json({ data: { requestId: request.id, status: request.status } })
    },
  }
}
