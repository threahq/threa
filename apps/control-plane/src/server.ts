import { createServer, type Server } from "http"
import {
  createDatabasePool,
  runMigrations,
  WorkosAuthService,
  StubAuthService,
  WorkosOrgServiceImpl,
  StubWorkosOrgService,
  OutboxDispatcher,
  OutboxRepository,
  CursorLock,
  DebounceWithMaxWait,
  ensureListenerFromLatest,
  logger,
  type OutboxEvent,
  type ProcessResult,
} from "@threa/backend-common"
import type { Pool } from "pg"
import path from "path"
import { createApp } from "./app"
import { registerRoutes } from "./routes"
import { loadControlPlaneConfig } from "./config"
import { RegionalClient } from "./lib/regional-client"
import { CloudflareKvClient, NoopKvClient, type KvClient } from "./lib/cloudflare-kv-client"
import {
  ControlPlaneWorkspaceService,
  OUTBOX_KV_SYNC,
  OUTBOX_REGIONAL_CREATE,
  type KvSyncPayload,
  type RegionalCreatePayload,
} from "./features/workspaces"
import { InvitationShadowService } from "./features/invitation-shadows"
import { WaitlistService } from "./features/waitlist"
import { BackofficeService, seedPlatformAdmins } from "./features/backoffice"
import {
  WorkosAuthzService,
  WorkosAuthzAdminService,
  WorkosAuthzBackfill,
  WorkosAuthzPoller,
  WORKOS_EVENT_POLLER_NAME,
  RegionalAuthzFanOut,
  OUTBOX_AUTHZ_MEMBERSHIP_CHANGED,
  OUTBOX_AUTHZ_MEMBERSHIP_REMOVED,
  type AuthzMembershipChangedPayload,
  type AuthzMembershipRemovedPayload,
} from "./features/workos-authz"
import { WorkosEventPollerLock } from "./lib/workos-event-poller-lock"
import { CONTROL_PLANE_LISTENER_ID } from "./lib/outbox-listeners"

const MIGRATIONS_GLOB = path.join(import.meta.dirname, "db/migrations/*.sql")
const LISTENER_ID = CONTROL_PLANE_LISTENER_ID

export interface ControlPlaneInstance {
  server: Server
  pool: Pool
  port: number
  fastShutdown: boolean
  stop: () => Promise<void>
}

export async function startServer(): Promise<ControlPlaneInstance> {
  const config = loadControlPlaneConfig()

  const pool = createDatabasePool(config.databaseUrl, { max: 10 })
  const listenPool = createDatabasePool(config.databaseUrl, { max: 2, idleTimeoutMillis: 60_000 })
  await runMigrations(pool, MIGRATIONS_GLOB)
  logger.info("Control plane database migrations complete")

  const authService = config.useStubAuth ? new StubAuthService() : new WorkosAuthService(config.workos)
  const workosOrgService = config.useStubAuth ? new StubWorkosOrgService() : new WorkosOrgServiceImpl(config.workos)

  const regionalClient = new RegionalClient(config.regions, config.internalApiKey)
  const kvClient: KvClient = config.cloudflareKv ? new CloudflareKvClient(config.cloudflareKv) : new NoopKvClient()

  const availableRegions = Object.keys(config.regions)
  const workspaceService = new ControlPlaneWorkspaceService({
    pool,
    regionalClient,
    workosOrgService,
    kvClient,
    availableRegions,
    requireWorkspaceCreationInvite: config.workspaceCreationRequiresInvite,
  })
  const shadowService = new InvitationShadowService({ pool, regionalClient, workosOrgService })
  const waitlistService = new WaitlistService({ pool })
  const workosAuthzAdminService = new WorkosAuthzAdminService({ pool, workosOrgService })
  await seedPlatformAdmins(pool, config.platformAdminWorkosUserIds)

  // Outbox — single handler for all control-plane events (no sharding needed)
  const cursorLock = new CursorLock({
    pool,
    listenerId: LISTENER_ID,
    lockDurationMs: 10_000,
    refreshIntervalMs: 5_000,
    maxRetries: 5,
    baseBackoffMs: 1_000,
    batchSize: 50,
  })

  const authzFanOut = new RegionalAuthzFanOut({ pool, regionalClient })

  const processEvents = async () => {
    await cursorLock.run(async (cursor, processedIds) => {
      const events = await OutboxRepository.fetchAfterId(pool, cursor, cursorLock.batchSize, processedIds)
      if (events.length === 0) return { status: "no_events" } as ProcessResult

      const seen: bigint[] = []
      let lastError: Error | undefined
      for (const event of events) {
        try {
          await dispatchEvent(event, { workspaceService, authzFanOut })
          seen.push(event.id)
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err))
          logger.error({ err, eventId: event.id, eventType: event.eventType }, "Outbox event processing failed")
        }
      }
      // Signal error to CursorLock so it applies backoff + DLQ for poison events,
      // while still saving partial progress for successfully processed events.
      if (lastError) {
        return { status: "error", error: lastError, processedIds: seen } as ProcessResult
      }
      return { status: "processed", processedIds: seen } as ProcessResult
    })
  }

  const debouncer = new DebounceWithMaxWait(processEvents, 50, 200, (err) => {
    logger.error({ err }, "Control-plane outbox handler error")
  })

  const outboxHandler = {
    listenerId: LISTENER_ID,
    handle: () => debouncer.trigger(),
  }

  const outboxDispatcher = new OutboxDispatcher({ listenPool })

  // WorkOS authz mirror — passive polling, no fan-out yet (Phase 1).
  // Multi-instance safe via the time-based lease in WorkosEventPollerLock,
  // mirroring the pattern used for the outbox CursorLock above.
  // Everything from here through `server.listen()` is wrapped so any failure
  // (listener bootstrap, dispatcher start, lock row creation, first-boot
  // backfill, port bind) tears down the workers and pools we already spun up
  // — otherwise a crashed boot leaks intervals and connections.
  let authzPoller: WorkosAuthzPoller | undefined
  let server: Server | undefined
  try {
    await ensureListenerFromLatest(pool, LISTENER_ID)
    outboxDispatcher.register(outboxHandler)
    await outboxDispatcher.start()

    const workosEventLock = new WorkosEventPollerLock({
      pool,
      name: WORKOS_EVENT_POLLER_NAME,
      lockDurationMs: 10_000,
      refreshIntervalMs: 5_000,
      maxRetries: 5,
      baseBackoffMs: 1_000,
    })
    await workosEventLock.ensureRow()

    const authzService = new WorkosAuthzService({ pool })
    const authzBackfill = new WorkosAuthzBackfill({ pool, workosOrgService, lock: workosEventLock })
    const backofficeService = new BackofficeService({
      pool,
      workosOrgService,
      authzBackfill,
      workspaceAppBaseUrl: config.frontendUrl,
      workosEnvironmentId: config.workosEnvironmentId,
    })
    authzPoller = new WorkosAuthzPoller({
      workosOrgService,
      authzService,
      lock: workosEventLock,
      pollIntervalMs: 5_000,
      batchSize: 100,
    })

    // First-boot backfill: only run when we've never backfilled before. Re-runs
    // happen via the bun script so an operator decides when to refresh.
    const lastBackfillRow = await pool.query<{ last_backfill_at: Date | null }>(
      "SELECT last_backfill_at FROM workos_event_poller_state WHERE name = $1",
      [WORKOS_EVENT_POLLER_NAME]
    )
    if (lastBackfillRow.rows[0]?.last_backfill_at == null) {
      try {
        await authzBackfill.run()
      } catch (err) {
        // Non-fatal: poller still starts; operator can run the backfill script later.
        logger.error({ err }, "Initial WorkOS authz backfill failed; poller will still start")
      }
    }
    authzPoller.start()

    const isProduction = process.env.NODE_ENV === "production"
    const app = createApp({ corsAllowedOrigins: config.corsAllowedOrigins })

    registerRoutes(app, {
      pool,
      authService,
      workspaceService,
      shadowService,
      waitlistService,
      backofficeService,
      workosAuthzAdminService,
      internalApiKey: config.internalApiKey,
      allowDevAuthRoutes: config.useStubAuth && !isProduction,
      frontendUrl: config.frontendUrl,
      allowedRedirectDomain: config.allowedRedirectDomain,
      regions: config.regions,
      workosDedicatedRedirectHosts: config.workosDedicatedRedirectHosts,
      rateLimits: config.rateLimits,
    })

    server = createServer(app)

    const listenServer = server
    await new Promise<void>((resolve, reject) => {
      listenServer.once("error", reject)
      listenServer.listen(config.port, "0.0.0.0", () => {
        listenServer.removeListener("error", reject)
        logger.info({ port: config.port }, "Control plane started")
        resolve()
      })
    })
  } catch (err) {
    await authzPoller?.stop().catch(() => {})
    await outboxDispatcher.stop().catch(() => {})
    await listenPool.end().catch(() => {})
    await pool.end().catch(() => {})
    throw err
  }

  // The try/catch above either returned with both set or rethrew, so we can
  // narrow safely here without runtime checks.
  const startedServer = server
  const startedPoller = authzPoller

  const stop = async () => {
    if (config.fastShutdown) {
      logger.info("Fast shutdown - skipping graceful shutdown")
      startedServer.close()
      await startedPoller.stop()
      await outboxDispatcher.stop()
      await listenPool.end()
      await pool.end()
      return
    }

    logger.info("Shutting down control plane...")
    if (startedServer.listening) {
      await new Promise<void>((resolve, reject) => {
        startedServer.close((err) => (err ? reject(err) : resolve()))
      })
    }
    await startedPoller.stop()
    await outboxDispatcher.stop()
    await listenPool.end()
    await pool.end()
    logger.info("Control plane stopped")
  }

  return { server: startedServer, pool, port: config.port, fastShutdown: config.fastShutdown, stop }
}

/** Dispatch a single outbox event to the appropriate service method (INV-34) */
async function dispatchEvent(
  event: OutboxEvent,
  deps: { workspaceService: ControlPlaneWorkspaceService; authzFanOut: RegionalAuthzFanOut }
): Promise<void> {
  const payload = event.payload as unknown
  switch (event.eventType) {
    case OUTBOX_REGIONAL_CREATE:
      await deps.workspaceService.provisionRegional(payload as RegionalCreatePayload)
      break
    case OUTBOX_KV_SYNC:
      await deps.workspaceService.syncToKv(payload as KvSyncPayload)
      break
    case OUTBOX_AUTHZ_MEMBERSHIP_CHANGED:
      await deps.authzFanOut.handleMembershipChanged(payload as AuthzMembershipChangedPayload)
      break
    case OUTBOX_AUTHZ_MEMBERSHIP_REMOVED:
      await deps.authzFanOut.handleMembershipRemoved(payload as AuthzMembershipRemovedPayload)
      break
    default:
      logger.warn({ eventType: event.eventType }, "Unknown outbox event type")
  }
}
