import type { Server } from "socket.io"
import { z } from "zod"
import { AGENT_STEP_TYPES, BOT_INVOCATION_CAPABILITIES, BOT_RUNTIME_KINDS, BOT_RUNTIME_STATUSES } from "@threa/types"
import { HttpError } from "@threa/backend-common"
import type { BotRuntimeService } from "./service"
import type { BotInvocation, BotRuntimeSessionLink, StreamActiveActor } from "./repository"
import type { BotRuntimeWriteOps } from "./runtime-write-ops"
import type { BotApiKeyService } from "../public-api"
import { botIdentityKeyFields, bothOrNeitherBotIdentityKey } from "../../lib/schemas"
import { createBotSocketAuthMiddleware, readSocketToken, type BotSocketData } from "./socket-auth"
import { BotSocketRegistry } from "./bot-socket-registry"
import { logger } from "../../lib/logger"

// Identifier chars only — these become Socket.IO room name segments
// (`bot:{ws}:bot:{botId}:instance:{instanceId}`), so anything outside the
// safe set risks ambiguous room matching or trips other parsers.
const instanceIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "instanceId must be 1-64 chars of [A-Za-z0-9_-]")
const runtimeSessionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "runtimeSessionId must be 1-64 chars of [A-Za-z0-9_-]")

const helloSchema = z
  .object({
    instanceId: instanceIdSchema,
    runtimeKind: z.enum(BOT_RUNTIME_KINDS),
    runtimeSessionId: runtimeSessionIdSchema.optional(),
    displayName: z.string().max(256).optional().nullable(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    supportedCapabilities: z.array(z.enum(BOT_INVOCATION_CAPABILITIES)).min(1),
    // Declared-output manifest (Phase 2.3b). Optional and additive — a runtime
    // that sends none keeps the legacy default profile and stays unenforced.
    // Once present, the verb boundary rejects any output it didn't declare. The
    // `output` object's fields default (reply+trace on, sources off), so sending
    // `manifest: { output: {} }` opts into enforcement at the default profile.
    manifest: z
      .object({
        output: z.object({
          reply: z.boolean().optional().default(true),
          trace: z.boolean().optional().default(true),
          sources: z.boolean().optional().default(false),
        }),
      })
      .optional(),
    // ISO timestamp — server echoes the next cursor in the ack and the runtime
    // sends it back on the following hello so we only replay events the
    // runtime hasn't already seen.
    sinceCursor: z.iso.datetime({ offset: true }).optional(),
    status: z.enum(BOT_RUNTIME_STATUSES).optional(),
    acceptingInvocations: z.boolean().optional(),
    // BIK — the runtime registers a fresh per-session public key here so the
    // SSK can be wrapped to it once invited into an E2E scratchpad. Shared
    // definition with the HTTP presence schema (INV-31) so they can't drift.
    ...botIdentityKeyFields,
  })
  .refine(bothOrNeitherBotIdentityKey, {
    message: "publicKey and publicKeyId must be provided together",
    path: ["publicKey"],
  })

export type BotHelloPayload = z.infer<typeof helloSchema>

// Bot invocation ids are prefixed ULIDs; bound loosely, the claim-token CAS is
// the real authorization (the socket identity proves the bot, not the claim).
const invocationIdSchema = z.string().min(1).max(64)
const claimTokenSchema = z.string().min(1).max(256)
const claimTtlSecondsSchema = z.number().int().min(15).max(300).optional().default(60)
const statusTextSchema = z.string().max(200).optional()

// WS frame for `bot:presence:update` — the socket-borne equivalent of
// POST /bot-runtime/presence. Mirrors `upsertPresenceSchema` (INV-31 keeps the
// HTTP body and the WS frame in lockstep; the duplication is deliberate to
// avoid a runtime import edge from bot-runtimes back into public-api).
// Exported so a parity test can assert these stay in lockstep with their HTTP
// counterparts (the duplication is deliberate — see above — so a test is the
// guard against field-level drift).
export const presenceUpdateSchema = z
  .object({
    runtimeKind: z.enum(BOT_RUNTIME_KINDS),
    instanceId: instanceIdSchema,
    runtimeSessionId: runtimeSessionIdSchema.optional(),
    displayName: z.string().max(100).optional().nullable(),
    status: z.enum(BOT_RUNTIME_STATUSES),
    acceptingInvocations: z.boolean(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    statusText: statusTextSchema,
    ...botIdentityKeyFields,
  })
  .refine(bothOrNeitherBotIdentityKey, {
    message: "publicKey and publicKeyId must be provided together",
    path: ["publicKey"],
  })

// WS frame for `bot:invocation:renew` — POST /bot-invocations/:id/renew, with
// the invocation id moved from the path into the frame.
export const invocationRenewSchema = z.object({
  invocationId: invocationIdSchema,
  instanceId: instanceIdSchema,
  claimToken: claimTokenSchema,
  claimTtlSeconds: claimTtlSecondsSchema,
})

// WS frame for `bot:invocation:steps` — the batched form of
// POST /bot-invocations/:id/steps. A single step is a one-element array, so the
// noisy per-tool-call fan-out coalesces into one frame + one ack.
export const invocationStepFrameSchema = z.object({
  stepType: z.enum(AGENT_STEP_TYPES),
  content: z.string().min(1).max(10_000),
  // Client idempotency key: a step re-sent under the same id dedups server-side.
  clientStepId: z.string().min(1).max(128).optional(),
})
const invocationStepsSchema = z.object({
  invocationId: invocationIdSchema,
  instanceId: instanceIdSchema,
  claimToken: claimTokenSchema,
  steps: z.array(invocationStepFrameSchema).min(1).max(50),
  statusText: statusTextSchema,
})

// WS frame for `bot:invocation:sealed-steps` — the batched form of
// POST /bot-invocations/:id/sealed-steps. Auth is the per-claim callback token
// (model A), not instanceId/claimToken, mirroring the HTTP header model; the
// content is ciphertext the server never reads (INV-E7), so there is no
// statusText (a plaintext status derived from sealed content would leak).
// `stepId` is client-minted and doubles as the idempotency key. No plaintext
// content cap applies — the envelope schema mirrors public-api's
// `sealedStreamEnvelopeSchema` (the duplication is deliberate, see above; the
// ws-http parity test guards field-level drift).
export const sealedStepFrameSchema = z.object({
  stepId: z.string().min(1).max(128),
  stepType: z.enum(AGENT_STEP_TYPES),
  messageId: z.string().min(1).max(128).optional(),
  ciphertext: z.base64().min(1),
  envelope: z.object({
    v: z.number(),
    keyGeneration: z.number().int().min(0),
    iv: z.base64().min(1),
    aad: z.base64().min(1),
  }),
  durationMs: z.number().int().min(0).optional(),
})
const invocationSealedStepsSchema = z.object({
  invocationId: invocationIdSchema,
  callbackToken: z.string().min(1).max(256),
  steps: z.array(sealedStepFrameSchema).min(1).max(50),
})

/**
 * Ack for the `/bot` write events. `ok: true` carries the same payload the REST
 * route returns; `ok: false` carries a `code` (the `HttpError` code, or
 * `INVALID_PAYLOAD` / `INTERNAL_ERROR`) so the client can tell terminal from
 * transient. A client treats any ack — ok or not — as "the server handled it";
 * only a missing ack or a dead socket triggers the HTTP fallback.
 */
export type BotWriteAck = { ok: true; data?: Record<string, unknown> } | { ok: false; code: string; message: string }

interface BotSocketHandlerDeps {
  io: Server
  botRuntimeService: BotRuntimeService
  botRuntimeWriteOps: BotRuntimeWriteOps
  botApiKeyService: BotApiKeyService
  botSocketRegistry: BotSocketRegistry
  /**
   * How often (ms) to re-check that the connecting key is still valid.
   * `BotApiKeyService.validateKey` has no cache, so HTTP revocation is
   * immediate on the next request — but a long-lived WS would otherwise
   * keep receiving pushes until the engine ping timeout. Default 60s.
   */
  keyRevalidationIntervalMs?: number
}

interface JoinedRoomState {
  instanceId: string
  runtimeKind: string
  runtimeSessionId: string | null
}

/**
 * Mounts the `/bot` Socket.IO namespace. Runtime bots authenticate with their
 * `threa_bk_*` key (see `socket-auth`), send a single `bot:hello` to register
 * their instance + capabilities, and get back a bootstrap snapshot of
 * available invocations + claims they already own.
 *
 * After bootstrap the runtime stops polling — it learns about new work via
 * `bot_invocation:available` / `:claimed` events dispatched by
 * `BroadcastHandler` to the rooms joined here.
 */
export function attachBotNamespace(deps: BotSocketHandlerDeps): void {
  const { io, botRuntimeService, botRuntimeWriteOps, botApiKeyService, botSocketRegistry } = deps
  const keyRevalidationIntervalMs = deps.keyRevalidationIntervalMs ?? 60_000
  const namespace = io.of("/bot")

  namespace.use(createBotSocketAuthMiddleware(botApiKeyService))

  namespace.on("connection", (socket) => {
    const auth = socket.data.bot as BotSocketData | undefined
    if (!auth) {
      // Belt-and-braces: middleware should reject anything without `bot`, but
      // if we somehow reached `connection` without it, drop the socket rather
      // than try to derive identity from an untrusted handshake.
      socket.disconnect(true)
      return
    }
    const { workspaceId, botId } = auth

    // Workspace-wide room is always safe — `bot:resync` with no botId fans
    // out to every bot socket in the workspace. The per-bot/instance rooms
    // are joined after `bot:hello` registers the instance identity.
    socket.join(`bot:${workspaceId}`)

    let joined: JoinedRoomState | null = null
    // Synchronous guard against a runtime that sends two `bot:hello` frames
    // before the first chain settles. The `joined` flag is only assigned
    // after three awaits, so checking it alone leaks both hellos through and
    // we'd double-upsert presence + send two acks. This flag flips to `true`
    // BEFORE the first await and clears in both success and catch paths.
    let helloInFlight = false

    // Periodic key revalidation. validateKey hits the DB every time so HTTP
    // revocation takes effect on the next tick (default 60s) instead of
    // having to wait for the engine's ping timeout.
    const token = readSocketToken(socket)
    const revalidationTimer: ReturnType<typeof setInterval> | null = token
      ? setInterval(async () => {
          try {
            const stillValid = await botApiKeyService.validateKey(token)
            if (!stillValid) {
              logger.info({ workspaceId, botId, keyId: auth.keyId }, "bot socket key revoked, disconnecting")
              socket.disconnect(true)
            }
          } catch (err) {
            logger.warn({ err, workspaceId, botId, keyId: auth.keyId }, "bot socket key revalidate failed")
            socket.disconnect(true)
          }
        }, keyRevalidationIntervalMs)
      : null

    socket.on("bot:hello", async (payload: unknown, ack?: (response: BotHelloResponse) => void): Promise<void> => {
      const parsed = helloSchema.safeParse(payload)
      if (!parsed.success) {
        const errorResponse: BotHelloResponse = {
          ok: false,
          error: "Invalid bot:hello payload",
          details: z.flattenError(parsed.error).fieldErrors,
        }
        ack?.(errorResponse)
        return
      }

      if (joined || helloInFlight) {
        // One hello per connection. A runtime that wants to change its
        // capabilities should reconnect — otherwise the room set would
        // drift from the registry entry. `helloInFlight` covers the
        // synchronous race where two frames arrive before the first chain
        // completes; `joined` covers any hello after a successful one.
        ack?.({ ok: false, error: "bot:hello already received on this connection" })
        return
      }
      helloInFlight = true

      const data = parsed.data
      const runtimeSessionId = data.runtimeSessionId ?? null
      const botRoom = `bot:${workspaceId}:bot:${botId}`
      const instanceRoom = `bot:${workspaceId}:bot:${botId}:instance:${data.instanceId}`
      const sessionRoom = runtimeSessionId ? `bot:${workspaceId}:bot:${botId}:session:${runtimeSessionId}` : null

      try {
        // Order matters: presence upsert → join rooms → bootstrap SELECT → register.
        // Joining BEFORE the bootstrap read closes the event-loss window. Anything
        // that lands between bootstrap-read and rooms-joined would otherwise be
        // dispatched into a room the socket isn't in yet. With join-first, the
        // socket sees overlap events twice (once via room push, once via the read)
        // and the runtime dedupes by invocation id — but never loses an event.
        // On error we leave the rooms so a retried hello on the same connection
        // re-enters with a clean state.
        await botRuntimeService.upsertPresenceFromBotKey({
          workspaceId,
          botId,
          runtimeKind: data.runtimeKind,
          instanceId: data.instanceId,
          displayName: data.displayName ?? null,
          status: data.status ?? "available",
          acceptingInvocations: data.acceptingInvocations ?? true,
          capabilities: {
            ...(data.capabilities ?? {}),
            ...(runtimeSessionId ? { runtimeSessionId } : {}),
          },
          manifest: data.manifest ?? null,
          publicKey: data.publicKey,
          publicKeyId: data.publicKeyId,
        })

        socket.join(botRoom)
        socket.join(instanceRoom)
        if (sessionRoom) socket.join(sessionRoom)

        const bootstrap = await botRuntimeService.getBootstrapForRuntime({
          workspaceId,
          botId,
          instanceId: data.instanceId,
          runtimeSessionId,
          supportedCapabilities: data.supportedCapabilities,
          sinceCursor: data.sinceCursor ? new Date(data.sinceCursor) : null,
        })

        botSocketRegistry.register({ workspaceId, botId, instanceId: data.instanceId }, socket)
        joined = {
          instanceId: data.instanceId,
          runtimeKind: data.runtimeKind,
          runtimeSessionId,
        }

        const response: BotHelloResponse = {
          ok: true,
          serverGeneratedAt: bootstrap.serverGeneratedAt.toISOString(),
          availableInvocations: bootstrap.available.map(serializeInvocation),
          ownedClaims: bootstrap.ownedClaims.map(serializeInvocation),
          activeActorByStream: bootstrap.activeActorByStream.map(serializeActiveActor),
          activeSessionLinks: bootstrap.activeSessionLinks.map(serializeSessionLink),
        }
        ack?.(response)
      } catch (err) {
        socket.leave(botRoom)
        socket.leave(instanceRoom)
        if (sessionRoom) socket.leave(sessionRoom)
        // Reset the in-flight flag so a retried hello on the same connection
        // can re-enter. `joined` stays null on the error path so the next
        // hello sees a clean slate.
        helloInFlight = false
        logger.error({ err, workspaceId, botId, instanceId: data.instanceId }, "bot:hello bootstrap failed")
        ack?.({ ok: false, error: "Internal error during bootstrap" })
      }
    })

    // Background-write events. These move the noisy runtime chatter
    // (presence/heartbeat, claim renewal, trace steps) off the HTTP path — every
    // HTTP POST is a billed edge request, while these frames ride the already-open
    // socket. They persist through the SAME `botRuntimeWriteOps` the REST routes
    // call (INV-35), so the two transports can never diverge. Authorization is the
    // socket's validated `threa_bk_*` key (workspace + bot + scope) plus the
    // per-claim `claimToken` carried in the frame — the socket identity alone does
    // not authorize a specific claim's writes.
    socket.on("bot:presence:update", async (payload: unknown, ack?: (response: BotWriteAck) => void): Promise<void> => {
      const parsed = presenceUpdateSchema.safeParse(payload)
      if (!parsed.success) {
        ack?.({ ok: false, code: "INVALID_PAYLOAD", message: "Invalid bot:presence:update payload" })
        return
      }
      const data = parsed.data
      try {
        await botRuntimeWriteOps.applyPresence({
          workspaceId,
          botId,
          runtimeKind: data.runtimeKind,
          instanceId: data.instanceId,
          runtimeSessionId: data.runtimeSessionId,
          displayName: data.displayName,
          status: data.status,
          acceptingInvocations: data.acceptingInvocations,
          capabilities: data.capabilities,
          statusText: data.statusText,
          publicKey: data.publicKey,
          publicKeyId: data.publicKeyId,
        })
        ack?.({ ok: true })
      } catch (err) {
        ack?.(toWriteErrorAck(err, { workspaceId, botId, event: "bot:presence:update" }))
      }
    })

    socket.on(
      "bot:invocation:renew",
      async (payload: unknown, ack?: (response: BotWriteAck) => void): Promise<void> => {
        const parsed = invocationRenewSchema.safeParse(payload)
        if (!parsed.success) {
          ack?.({ ok: false, code: "INVALID_PAYLOAD", message: "Invalid bot:invocation:renew payload" })
          return
        }
        const data = parsed.data
        try {
          const renewed = await botRuntimeWriteOps.renewClaim({
            workspaceId,
            botId,
            invocationId: data.invocationId,
            instanceId: data.instanceId,
            claimToken: data.claimToken,
            claimTtlSeconds: data.claimTtlSeconds,
          })
          ack?.({ ok: true, data: { ...renewed } })
        } catch (err) {
          ack?.(toWriteErrorAck(err, { workspaceId, botId, event: "bot:invocation:renew" }))
        }
      }
    )

    socket.on(
      "bot:invocation:steps",
      async (payload: unknown, ack?: (response: BotWriteAck) => void): Promise<void> => {
        const parsed = invocationStepsSchema.safeParse(payload)
        if (!parsed.success) {
          ack?.({ ok: false, code: "INVALID_PAYLOAD", message: "Invalid bot:invocation:steps payload" })
          return
        }
        const data = parsed.data
        try {
          const result = await botRuntimeWriteOps.recordSteps({
            workspaceId,
            botId,
            invocationId: data.invocationId,
            instanceId: data.instanceId,
            claimToken: data.claimToken,
            steps: data.steps,
            statusText: data.statusText,
          })
          ack?.({
            ok: true,
            data: { invocationId: result.invocationId, sessionId: result.sessionId, steps: result.steps },
          })
        } catch (err) {
          ack?.(toWriteErrorAck(err, { workspaceId, botId, event: "bot:invocation:steps" }))
        }
      }
    )

    socket.on(
      "bot:invocation:sealed-steps",
      async (payload: unknown, ack?: (response: BotWriteAck) => void): Promise<void> => {
        const parsed = invocationSealedStepsSchema.safeParse(payload)
        if (!parsed.success) {
          ack?.({ ok: false, code: "INVALID_PAYLOAD", message: "Invalid bot:invocation:sealed-steps payload" })
          return
        }
        const data = parsed.data
        try {
          const result = await botRuntimeWriteOps.recordSealedSteps({
            workspaceId,
            botId,
            invocationId: data.invocationId,
            callbackToken: data.callbackToken,
            steps: data.steps,
          })
          ack?.({
            ok: true,
            data: { invocationId: result.invocationId, sessionId: result.sessionId, steps: result.steps },
          })
        } catch (err) {
          ack?.(toWriteErrorAck(err, { workspaceId, botId, event: "bot:invocation:sealed-steps" }))
        }
      }
    )

    socket.on("disconnect", () => {
      if (revalidationTimer) clearInterval(revalidationTimer)
      if (joined) {
        botSocketRegistry.unregister({ workspaceId, botId, instanceId: joined.instanceId }, socket)
      }
    })
  })
}

/**
 * Map a thrown write-op error to a `BotWriteAck`. `HttpError` (claim-not-found,
 * manifest-rejected, stream-inaccessible) carries a definitive `code` the client
 * trusts as terminal — it will not retry over HTTP. Anything else is logged and
 * surfaced as `INTERNAL_ERROR`.
 */
function toWriteErrorAck(
  err: unknown,
  ctx: { workspaceId: string; botId: string; event: string }
): { ok: false; code: string; message: string } {
  if (err instanceof HttpError) {
    return { ok: false, code: err.code ?? "ERROR", message: err.message }
  }
  logger.error({ err, ...ctx }, "bot socket write event failed")
  return { ok: false, code: "INTERNAL_ERROR", message: "Internal error" }
}

export interface SerializedBotInvocation {
  id: string
  workspaceId: string
  rootStreamId: string
  activeStreamId: string
  sourceMessageId: string
  responseStreamId: string
  actorType: "bot"
  actorId: string
  trigger: string
  requiredCapability: string
  promptMarkdown: string
  authorUserId: string
  mentionedActorSlugs: string[]
  targetInstanceId: string | null
  targetRuntimeSessionId: string | null
  metadata: Record<string, unknown>
  status: string
  // `claimToken` and `claimedByInstanceId` are intentionally omitted:
  // `claimToken` is the credential the complete/renew/fail endpoints
  // authorize on, and the bootstrap filters `ownedClaims` only by the
  // attacker-supplied `instanceId`. Echoing them back would let any holder
  // of the bot's API key impersonate a sibling instance via `bot:hello`
  // and sabotage that instance's in-flight claims. The runtime already
  // owns the token it was handed at claim time.
  claimExpiresAt: string | null
  attempts: number
  errorMessage: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface SerializedStreamActiveActor {
  rootStreamId: string
  actorType: "persona" | "bot"
  actorId: string
  updatedAt: string
}

export interface SerializedBotSessionLink {
  rootStreamId: string
  activeStreamId: string
  runtimeSessionId: string
  status: string
  lastSeenAt: string | null
}

export type BotHelloResponse =
  | {
      ok: true
      serverGeneratedAt: string
      availableInvocations: SerializedBotInvocation[]
      ownedClaims: SerializedBotInvocation[]
      activeActorByStream: SerializedStreamActiveActor[]
      activeSessionLinks: SerializedBotSessionLink[]
    }
  | {
      ok: false
      error: string
      details?: Record<string, unknown>
    }

function serializeActiveActor(a: StreamActiveActor): SerializedStreamActiveActor {
  return {
    rootStreamId: a.rootStreamId,
    actorType: a.actorType,
    actorId: a.actorId,
    updatedAt: a.updatedAt.toISOString(),
  }
}

function serializeSessionLink(link: BotRuntimeSessionLink): SerializedBotSessionLink {
  return {
    rootStreamId: link.rootStreamId,
    activeStreamId: link.activeStreamId,
    runtimeSessionId: link.runtimeSessionId,
    status: link.status,
    lastSeenAt: link.lastSeenAt?.toISOString() ?? null,
  }
}

function serializeInvocation(inv: BotInvocation): SerializedBotInvocation {
  return {
    id: inv.id,
    workspaceId: inv.workspaceId,
    rootStreamId: inv.rootStreamId,
    activeStreamId: inv.activeStreamId,
    sourceMessageId: inv.sourceMessageId,
    responseStreamId: inv.responseStreamId,
    actorType: inv.actorType,
    actorId: inv.actorId,
    trigger: inv.trigger,
    requiredCapability: inv.requiredCapability,
    promptMarkdown: inv.promptMarkdown,
    authorUserId: inv.authorUserId,
    mentionedActorSlugs: inv.mentionedActorSlugs,
    targetInstanceId: inv.targetInstanceId,
    targetRuntimeSessionId: inv.targetRuntimeSessionId,
    metadata: inv.metadata,
    status: inv.status,
    claimExpiresAt: inv.claimExpiresAt?.toISOString() ?? null,
    attempts: inv.attempts,
    errorMessage: inv.errorMessage,
    createdAt: inv.createdAt.toISOString(),
    updatedAt: inv.updatedAt.toISOString(),
    completedAt: inv.completedAt?.toISOString() ?? null,
  }
}

export { BotSocketRegistry } from "./bot-socket-registry"
