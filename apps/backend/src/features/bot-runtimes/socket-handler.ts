import type { Server, Socket } from "socket.io"
import { z } from "zod"
import { BOT_INVOCATION_CAPABILITIES, BOT_RUNTIME_KINDS, BOT_RUNTIME_STATUSES } from "@threa/types"
import type { BotRuntimeService } from "./service"
import type { BotInvocation } from "./repository"
import type { BotApiKeyService } from "../public-api"
import { createBotSocketAuthMiddleware, readSocketToken, type BotSocketData } from "./socket-auth"
import { BotSocketRegistry } from "./bot-socket-registry"
import { logger } from "../../lib/logger"

const helloSchema = z.object({
  instanceId: z.string().min(1).max(128),
  runtimeKind: z.enum(BOT_RUNTIME_KINDS),
  runtimeSessionId: z.string().min(1).max(128).optional(),
  displayName: z.string().max(256).optional().nullable(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  supportedCapabilities: z.array(z.enum(BOT_INVOCATION_CAPABILITIES)).min(1),
  // ISO timestamp — server echoes the next cursor in the ack and the runtime
  // sends it back on the following hello so we only replay events the
  // runtime hasn't already seen.
  sinceCursor: z.iso.datetime({ offset: true }).optional(),
  status: z.enum(BOT_RUNTIME_STATUSES).optional(),
  acceptingInvocations: z.boolean().optional(),
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

      if (joined) {
        // One hello per connection. A runtime that wants to change its
        // capabilities should reconnect — otherwise the room set would
        // drift from the registry entry.
        ack?.({ ok: false, error: "bot:hello already received on this connection" })
        return
      }

      const data = parsed.data
      const runtimeSessionId = data.runtimeSessionId ?? null

      try {
        // Presence upsert mirrors the HTTP `upsertPresenceFromBotKey` path so
        // a runtime that just switched transports doesn't appear offline
        // while it waits for its next claim/heartbeat tick.
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
        })

        socket.join(`bot:${workspaceId}:bot:${botId}`)
        socket.join(`bot:${workspaceId}:bot:${botId}:instance:${data.instanceId}`)
        if (runtimeSessionId) {
          socket.join(`bot:${workspaceId}:bot:${botId}:session:${runtimeSessionId}`)
        }

        joined = {
          instanceId: data.instanceId,
          runtimeKind: data.runtimeKind,
          runtimeSessionId,
        }
        botSocketRegistry.register({ workspaceId, botId, instanceId: data.instanceId }, socket)

        const bootstrap = await botRuntimeService.getBootstrapForRuntime({
          workspaceId,
          botId,
          instanceId: data.instanceId,
          runtimeSessionId,
          supportedCapabilities: data.supportedCapabilities,
          sinceCursor: data.sinceCursor ? new Date(data.sinceCursor) : null,
        })

        const response: BotHelloResponse = {
          ok: true,
          serverGeneratedAt: bootstrap.serverGeneratedAt.toISOString(),
          availableInvocations: bootstrap.available.map(serializeInvocation),
          ownedClaims: bootstrap.ownedClaims.map(serializeInvocation),
        }
        ack?.(response)
      } catch (err) {
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
  claimedByInstanceId: string | null
  claimToken: string | null
  claimExpiresAt: string | null
  attempts: number
  errorMessage: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export type BotHelloResponse =
  | {
      ok: true
      serverGeneratedAt: string
      availableInvocations: SerializedBotInvocation[]
      ownedClaims: SerializedBotInvocation[]
    }
  | {
      ok: false
      error: string
      details?: Record<string, unknown>
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
    claimedByInstanceId: inv.claimedByInstanceId,
    claimToken: inv.claimToken,
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
