import type { Querier } from "../../db"
import { sql } from "../../db"
import { tokenId } from "../id"

interface QueueTokenRow {
  id: string
  queue_name: string
  workspace_id: string
  leased_at: Date
  leased_by: string
  leased_until: Date
  next_process_after: Date
  created_at: Date
}

export interface QueueToken {
  id: string
  queueName: string
  workspaceId: string
  leasedAt: Date
  leasedBy: string
  leasedUntil: Date
  nextProcessAfter: Date
  createdAt: Date
}

export interface BatchLeaseTokensParams {
  leasedBy: string
  leasedAt: Date
  leasedUntil: Date
  now: Date
  limit: number
  queueNames: string[] // Only lease tokens for these queues
  /**
   * Fairness mode:
   * - "workspace" (default for this function) leases one token per
   *   (queue_name, workspace_id) pair, preventing a single workspace from
   *   starving others.
   * - "none" allows multiple concurrent tokens per (queue_name, workspace_id)
   *   pair, letting a single workspace use the full tier budget.
   *
   * Note: QueueManager always passes this explicitly based on handler
   * registration (default there is `QueueFairness.NONE`). The repository
   * default of "workspace" is a safety net for direct callers only.
   */
  fairnessMode?: "workspace" | "none"
}

export interface RenewLeaseParams {
  tokenId: string
  leasedBy: string
  leasedUntil: Date
}

export interface DeleteTokenParams {
  tokenId: string
  leasedBy: string
}

export interface DeleteExpiredTokensParams {
  now: Date
}

function mapRowToToken(row: QueueTokenRow): QueueToken {
  return {
    id: row.id,
    queueName: row.queue_name,
    workspaceId: row.workspace_id,
    leasedAt: row.leased_at,
    leasedBy: row.leased_by,
    leasedUntil: row.leased_until,
    nextProcessAfter: row.next_process_after,
    createdAt: row.created_at,
  }
}

const SELECT_FIELDS = sql.raw(`
  id, queue_name, workspace_id,
  leased_at, leased_by, leased_until,
  next_process_after, created_at
`)

export const TokenPoolRepository = {
  /**
   * Atomically lease a batch of tokens. Returns empty array if no work available.
   *
   * TODO: Implement chunking based on scalingThreshold - split pairs with high
   * pending_count into multiple tokens.
   */
  async batchLeaseTokens(db: Querier, params: BatchLeaseTokensParams): Promise<QueueToken[]> {
    const fairnessMode = params.fairnessMode ?? "workspace"

    // Pre-generate ULIDs (INV-2). Usage is bounded by available pairs.
    const tokenIds = Array.from({ length: params.limit }, () => tokenId())

    // Two query shapes, one per fairness mode. We keep them as separate
    // tagged-template SQL literals because squid's `sql` tag returns a
    // QueryConfig (not a composable fragment), so interpolating one sql block
    // inside another would stringify the object.
    //
    // - "workspace": preserves the pre-existing behaviour — at most one active
    //   token per (queue_name, workspace_id) pair. Prevents a noisy workspace
    //   from starving others on the same instance.
    // - "none":      expands each pair into up to `pending_count` slots so a
    //   single workspace burst can consume the full tier budget. Concurrent
    //   claims are made race-safe by batchClaimMessages' FOR UPDATE SKIP LOCKED.
    const result =
      fairnessMode === "workspace"
        ? await db.query<QueueTokenRow>(
            sql`
              WITH available_pairs AS (
                SELECT
                  queue_name,
                  workspace_id,
                  MIN(process_after) AS next_process_after,
                  COUNT(*) AS pending_count
                FROM queue_messages
                WHERE process_after <= ${params.now}
                  AND dlq_at IS NULL
                  AND completed_at IS NULL
                  -- Must mirror idx_queue_messages_available's partial predicate
                  -- (dlq/completed/cancelled all NULL) or the planner seq-scans.
                  AND cancelled_at IS NULL
                  AND (claimed_until IS NULL OR claimed_until < ${params.now})
                  AND queue_name = ANY(${params.queueNames})
                GROUP BY queue_name, workspace_id
              ),
              pairs_without_tokens AS (
                -- Exclude pairs that already have active tokens
                SELECT
                  ap.queue_name,
                  ap.workspace_id,
                  ap.next_process_after,
                  ap.pending_count
                FROM available_pairs ap
                LEFT JOIN queue_tokens qt ON
                  qt.queue_name = ap.queue_name
                  AND qt.workspace_id = ap.workspace_id
                  AND qt.leased_until > ${params.now}
                WHERE qt.id IS NULL
              ),
              selected_pairs AS (
                SELECT
                  queue_name,
                  workspace_id,
                  next_process_after,
                  ROW_NUMBER() OVER (ORDER BY next_process_after ASC) AS rn
                FROM pairs_without_tokens
                ORDER BY next_process_after ASC
                LIMIT ${params.limit}
              ),
              token_ids AS (
                SELECT
                  id,
                  ROW_NUMBER() OVER () AS rn
                FROM unnest(${tokenIds}::text[]) AS id
              )
              INSERT INTO queue_tokens (
                id, queue_name, workspace_id,
                leased_at, leased_by, leased_until,
                next_process_after, created_at
              )
              SELECT
                t.id,
                sp.queue_name,
                sp.workspace_id,
                ${params.leasedAt},
                ${params.leasedBy},
                ${params.leasedUntil},
                sp.next_process_after,
                ${params.leasedAt}
              FROM selected_pairs sp
              JOIN token_ids t ON t.rn = sp.rn
              RETURNING ${SELECT_FIELDS}
            `
          )
        : await db.query<QueueTokenRow>(
            sql`
              WITH available_pairs AS (
                SELECT
                  queue_name,
                  workspace_id,
                  MIN(process_after) AS next_process_after,
                  COUNT(*) AS pending_count
                FROM queue_messages
                WHERE process_after <= ${params.now}
                  AND dlq_at IS NULL
                  AND completed_at IS NULL
                  AND cancelled_at IS NULL
                  AND (claimed_until IS NULL OR claimed_until < ${params.now})
                  AND queue_name = ANY(${params.queueNames})
                GROUP BY queue_name, workspace_id
              ),
              expanded_slots AS (
                -- Expand each pair into up to pending_count slots so a
                -- single workspace can claim multiple concurrent tokens.
                SELECT
                  ap.queue_name,
                  ap.workspace_id,
                  ap.next_process_after,
                  generate_series(1, LEAST(ap.pending_count::int, ${params.limit}::int)) AS slot_num
                FROM available_pairs ap
              ),
              selected_pairs AS (
                -- Interleave: take slot 1 of every pair (oldest first), then
                -- slot 2 of every pair, etc. This prevents one workspace with
                -- a lot of pending work from starving another workspace that
                -- also has work ready under fairness=none.
                SELECT
                  queue_name,
                  workspace_id,
                  next_process_after,
                  ROW_NUMBER() OVER (ORDER BY slot_num ASC, next_process_after ASC) AS rn
                FROM expanded_slots
                ORDER BY slot_num ASC, next_process_after ASC
                LIMIT ${params.limit}
              ),
              token_ids AS (
                SELECT
                  id,
                  ROW_NUMBER() OVER () AS rn
                FROM unnest(${tokenIds}::text[]) AS id
              )
              INSERT INTO queue_tokens (
                id, queue_name, workspace_id,
                leased_at, leased_by, leased_until,
                next_process_after, created_at
              )
              SELECT
                t.id,
                sp.queue_name,
                sp.workspace_id,
                ${params.leasedAt},
                ${params.leasedBy},
                ${params.leasedUntil},
                sp.next_process_after,
                ${params.leasedAt}
              FROM selected_pairs sp
              JOIN token_ids t ON t.rn = sp.rn
              RETURNING ${SELECT_FIELDS}
            `
          )

    return result.rows.map(mapRowToToken)
  },

  /** Verifies leasedBy so only the holder renews; returns false if the lease was lost. */
  async renewLease(db: Querier, params: RenewLeaseParams): Promise<boolean> {
    const result = await db.query(
      sql`
        UPDATE queue_tokens
        SET leased_until = ${params.leasedUntil}
        WHERE id = ${params.tokenId}
          AND leased_by = ${params.leasedBy}
      `
    )

    return (result.rowCount ?? 0) > 0
  },

  /** Verifies leasedBy so only the holder releases the token. */
  async deleteToken(db: Querier, params: DeleteTokenParams): Promise<void> {
    const result = await db.query(
      sql`
        DELETE FROM queue_tokens
        WHERE id = ${params.tokenId}
          AND leased_by = ${params.leasedBy}
      `
    )

    if ((result.rowCount ?? 0) === 0) {
      throw new Error(`Failed to delete token ${params.tokenId}: not found or wrong leasedBy`)
    }
  },

  async deleteExpiredTokens(db: Querier, params: DeleteExpiredTokensParams): Promise<number> {
    const result = await db.query(
      sql`
        DELETE FROM queue_tokens
        WHERE leased_until < ${params.now}
      `
    )

    return result.rowCount ?? 0
  },

  /** For testing/debugging. */
  async getById(db: Querier, id: string): Promise<QueueToken | null> {
    const result = await db.query<QueueTokenRow>(
      sql`
        SELECT ${SELECT_FIELDS}
        FROM queue_tokens
        WHERE id = ${id}
      `
    )

    return result.rows[0] ? mapRowToToken(result.rows[0]) : null
  },
}
