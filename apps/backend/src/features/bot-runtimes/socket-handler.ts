import type { Server } from "socket.io"
import { z } from "zod"
import { BOT_INVOCATION_CAPABILITIES, BOT_RUNTIME_KINDS, BOT_RUNTIME_STATUSES } from "@threa/types"
import type { BotRuntimeService } from "./service"
import type { BotInvocation, BotRuntimeSessionLink, StreamActiveActor } from "./repository"
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

interface BotSocketHandlerDeps {
  io: Server
  botRuntimeService: BotRuntimeService
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
  const { io, botRuntimeService, botApiKeyService, botSocketRegistry } = deps
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

    socket.on("disconnect", () => {
      if (revalidationTimer) clearInterval(revalidationTimer)
      if (joined) {
        botSocketRegistry.unregister({ workspaceId, botId, instanceId: joined.instanceId }, socket)
      }
    })
  })
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

// Re-export for convenience.
export { BotSocketRegistry } from "./bot-socket-registry"
