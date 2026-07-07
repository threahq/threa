import { Pool, PoolClient, PoolConfig, QueryConfig, QueryResult, QueryResultRow } from "pg"
import { sql } from "squid/pg"
import { ulid } from "ulid"
import { logger } from "../logger"

export { sql }

/**
 * Common interface for database query execution.
 * Both Pool and PoolClient satisfy this interface.
 *
 * - Pass Pool for simple queries (auto-acquires and releases connection)
 * - Pass PoolClient when you need a transaction or connection affinity
 *
 * This mirrors Go's pattern where pgx.Pool implements the same Querier
 * interface as pgx.Conn, allowing flexible connection management.
 */
export interface Querier {
  query<R extends QueryResultRow = QueryResultRow>(
    queryTextOrConfig: string | QueryConfig,
    values?: unknown[]
  ): Promise<QueryResult<R>>
}

/**
 * Default pool configuration.
 *
 * IMPORTANT: connectionTimeoutMillis must be long enough to handle thundering herd
 * at startup when 15+ workers simultaneously request connections from an empty pool.
 * With 2000ms timeout, connection establishment fails and creates phantom connections.
 */
const DEFAULT_POOL_CONFIG: Partial<PoolConfig> = {
  max: 30,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000, // 2000ms is too short for the startup stampede
}

export function createDatabasePool(connectionString: string, config?: Partial<PoolConfig>): Pool {
  const pool = new Pool({
    connectionString,
    ...DEFAULT_POOL_CONFIG,
    ...config,
  })

  pool.on("error", (err: Error & { code?: string }) => {
    // 57P05 = idle-session timeout - PostgreSQL killed an idle connection
    // This is NORMAL behavior with idle_session_timeout configured
    // pg-pool will automatically remove the dead connection from the pool
    if (err.code === "57P05") {
      logger.info(
        {
          code: err.code,
          message: err.message,
        },
        "Connection killed by PostgreSQL idle-session timeout (expected with idle_session_timeout=60s)"
      )
      return
    }

    logger.error({ err, code: err.code }, "Unexpected database pool error")
  })

  return pool
}

/**
 * Database pool configuration for different concerns.
 * Separating pools prevents one category from starving another.
 */
export interface DatabasePools {
  /** Main pool for services, workers, and general queries (30 max) */
  main: Pool
  /** Pool for the held LISTEN connections (outbox dispatcher + enclave nudge, ~2 in steady state; 12 max) */
  listen: Pool
  /**
   * Dedicated pool for real-time delivery outbox handlers (broadcast + push).
   * Reserved capacity so a saturated main pool (e.g. AI workers holding
   * connections) can never delay socket.io broadcasts or push notifications.
   */
  realtime: Pool
}

/**
 * Create separated database pools for different concerns.
 *
 * - main: Used by services, workers, queue system, and HTTP handlers (30 connections)
 * - listen: Dedicated to OutboxListener LISTEN connections (12 connections)
 * - realtime: Dedicated to the broadcast + push outbox handlers (8 connections)
 *
 * This separation ensures that long-held LISTEN connections don't compete
 * with transactional work for pool slots, and that real-time message delivery
 * is never starved by background workers (AI, embeddings, file processing).
 *
 * Pool sizing rationale:
 * - main (30): Handles concurrent HTTP requests, workers, and queue jobs
 * - listen (12): ~2 held LISTEN connections (OutboxDispatcher's single fan-out
 *   LISTEN + EnclaveClaimNudge when configured) plus generous reconnect headroom
 * - realtime (8): Broadcast handler (fetchAfterId + cursor lock) + push handler
 *   (fetchAfterId + cursor lock + sequential delivery) + socket.io postgres
 *   adapter (1 persistent LISTEN + pg_notify publishes). Adapter holds 1 slot
 *   permanently; push delivery is sequential to preserve cursor correctness;
 *   leaves ample headroom for broadcast and pg_notify fan-out.
 */
export function createDatabasePools(connectionString: string): DatabasePools {
  const mainMax = Number(process.env.DATABASE_POOL_MAX) || 30
  // Steady state this pool holds ~2 LISTEN connections: the OutboxDispatcher's
  // single fan-out LISTEN (it dispatches to every registered handler over one
  // connection — each handler does its work on its own transactional pool
  // (main or realtime) when woken, none holds a LISTEN connection of its own)
  // plus EnclaveClaimNudge's LISTEN when enclave is configured. Default 12 is
  // mostly reconnect headroom. Env-configurable via DATABASE_LISTEN_POOL_MAX so
  // shared-DB deploys (PR previews on the same Postgres as main staging) can
  // shrink to ~4 without starving.
  const listenMax = Number(process.env.DATABASE_LISTEN_POOL_MAX) || 12
  const realtimeMax = Number(process.env.DATABASE_REALTIME_POOL_MAX) || 8

  const main = createDatabasePool(connectionString, { max: mainMax })

  const listen = createDatabasePool(connectionString, {
    max: listenMax,
    // LISTEN connections are held indefinitely - longer idle timeout
    idleTimeoutMillis: 60000,
  })

  // Realtime pool reserved for real-time delivery:
  //   - BroadcastHandler (outbox fetch + cursor lock)
  //   - PushNotificationHandler (outbox fetch + cursor lock + sequential delivery)
  //   - PushService (subscription lookups, webpush delivery)
  //   - socket.io postgres adapter (1 persistent LISTEN + pg_notify publishes)
  //
  // Push delivery is sequential within a batch (parallel would risk message
  // loss via CursorLock gap-window expiry — see outbox-handler.ts). The
  // adapter's persistent LISTEN holds 1 slot permanently, leaving ~7 for
  // transactional work. A saturated main pool cannot delay message delivery
  // because this pool is fully isolated.
  const realtime = createDatabasePool(connectionString, { max: realtimeMax })

  // Effective per-instance connection ceiling — the number that matters when
  // many PR-preview backends share one Postgres (shrunk via the DATABASE_*_POOL_MAX
  // env vars in that case).
  logger.info({ mainMax, listenMax, realtimeMax }, "Database pools created")

  return { main, listen, realtime }
}

/**
 * Check if an error is a recoverable connection error that warrants a retry.
 */
function isRecoverableConnectionError(err: unknown): boolean {
  const error = err as Error & { code?: string }
  // 57P05 = idle-session timeout - connection was killed, can retry with new connection
  // ECONNRESET = connection reset - network issue, can retry
  return error.code === "57P05" || error.code === "ECONNRESET"
}

// 40P01 = deadlock_detected, 40001 = serialization_failure. Postgres aborts one
// transaction in a lock cycle; the documented remedy is to roll back and retry
// the whole transaction (INV-20). The connection itself stays healthy, so unlike
// a connection error we reuse it rather than destroying it.
function isRetryableTransactionError(err: unknown): boolean {
  const error = err as Error & { code?: string }
  return error.code === "40P01" || error.code === "40001"
}

const MAX_TRANSACTION_ATTEMPTS = 3

/**
 * Check if a querier is a PoolClient (already has connection, possibly in transaction).
 * PoolClient has a `release` method that Pool doesn't have.
 */
function isPoolClient(db: Pool | PoolClient): db is PoolClient {
  return "release" in db && typeof db.release === "function"
}

/**
 * Execute callback in a transaction.
 *
 * Supports nested transactions via savepoints:
 * - Pass Pool: starts a new transaction (BEGIN/COMMIT)
 * - Pass PoolClient: uses a savepoint (nested transaction)
 *
 * This allows callers to use withTransaction without knowing if they're
 * already inside a transaction - the right thing happens automatically.
 */
export async function withTransaction<T>(
  db: Pool | PoolClient,
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  if (isPoolClient(db)) {
    const savepointName = `sp_${ulid()}`
    await db.query(`SAVEPOINT ${savepointName}`)
    try {
      const result = await callback(db)
      await db.query(`RELEASE SAVEPOINT ${savepointName}`)
      return result
    } catch (error) {
      await db.query(`ROLLBACK TO SAVEPOINT ${savepointName}`).catch(() => {
        // Ignore rollback errors
      })
      throw error
    }
  }

  let lastError: unknown

  for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt++) {
    const client = await db.connect()
    let released = false
    try {
      await client.query("BEGIN")
      const result = await callback(client)
      await client.query("COMMIT")
      return result
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        // Ignore rollback errors (connection might be dead)
      })

      lastError = error
      const isLastAttempt = attempt === MAX_TRANSACTION_ATTEMPTS - 1

      // Recoverable connection errors: retry once with a fresh connection.
      if (attempt === 0 && isRecoverableConnectionError(error)) {
        logger.debug(
          { err: error, attempt: attempt + 1 },
          "Transaction failed with recoverable connection error, retrying..."
        )
        released = true
        client.release(true) // Destroy the bad connection
        continue
      }

      // Deadlock / serialization failures are transient under concurrency. Return
      // the healthy connection to the pool and retry after a little jittered
      // backoff so the contending transactions don't immediately re-collide.
      if (!isLastAttempt && isRetryableTransactionError(error)) {
        logger.debug(
          { err: error, attempt: attempt + 1 },
          "Transaction failed with retryable serialization error, retrying..."
        )
        released = true
        client.release()
        await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20))
        continue
      }

      throw error
    } finally {
      if (!released) client.release()
    }
  }

  throw lastError
}

export async function withClient<T>(pool: Pool, callback: (client: PoolClient) => Promise<T>): Promise<T> {
  let lastError: unknown

  // Retry once on recoverable connection errors
  for (let attempt = 0; attempt < 2; attempt++) {
    const client = await pool.connect()
    let released = false
    try {
      return await callback(client)
    } catch (error) {
      lastError = error

      // Only retry on recoverable connection errors, and only on first attempt
      if (attempt === 0 && isRecoverableConnectionError(error)) {
        logger.debug(
          { err: error, attempt: attempt + 1 },
          "Query failed with recoverable connection error, retrying..."
        )
        released = true
        client.release(true) // Destroy the bad connection
        continue
      }

      throw error
    } finally {
      if (!released) client.release()
    }
  }

  throw lastError
}

/**
 * Pre-warm pool by creating initial connections.
 *
 * Prevents "thundering herd" at startup where 15+ workers simultaneously
 * request connections from an empty pool, causing timeouts and phantom connections.
 *
 * @param pool Pool to warm
 * @param count Number of connections to pre-create (default: 10)
 */
export async function warmPool(pool: Pool, count: number = 10): Promise<void> {
  const clients: PoolClient[] = []

  try {
    // Acquire connections one at a time to avoid overwhelming PostgreSQL
    for (let i = 0; i < count; i++) {
      const client = await pool.connect()
      clients.push(client)
    }

    await Promise.all(clients.map((client) => client.query("SELECT 1")))
  } finally {
    for (const client of clients) {
      client.release()
    }
  }
}
