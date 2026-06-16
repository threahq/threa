import type { Pool } from "pg"
import { sql } from "../../db"
import { agentSessionsActive, agentSessionDuration } from "../../lib/observability"
import { logger } from "../../lib/logger"

interface SessionCountRow {
  workspace_id: string
  status: string
  count: string
}

interface CompletedSessionRow {
  workspace_id: string
  status: string
  duration_seconds: string // PostgreSQL EXTRACT returns numeric as string
}

/**
 * Periodic collector for agent session metrics.
 *
 * Queries the database every 30s to update:
 * - agentSessionsActive: Gauge of sessions by workspace and status
 * - agentSessionDuration: Histogram of completed session durations
 */
export class AgentSessionMetricsCollector {
  private readonly pool: Pool
  private readonly intervalMs: number
  private intervalId: NodeJS.Timeout | null = null
  private lastCollectedAt: Date | null = null

  constructor(pool: Pool, options?: { intervalMs?: number }) {
    this.pool = pool
    this.intervalMs = options?.intervalMs ?? 30000
  }

  start(): void {
    if (this.intervalId) {
      return
    }

    this.collect().catch((err) => logger.error({ err }, "Initial agent session metrics collection failed"))
    this.intervalId = setInterval(() => {
      this.collect().catch((err) => logger.error({ err }, "Agent session metrics collection failed"))
    }, this.intervalMs)

    logger.info({ intervalMs: this.intervalMs }, "Agent session metrics collector started")
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
      logger.info("Agent session metrics collector stopped")
    }
  }

  private async collect(): Promise<void> {
    const now = new Date()

    // Reset gauge before updating (to handle sessions that no longer exist)
    agentSessionsActive.reset()

    const countResult = await this.pool.query<SessionCountRow>(sql`
      SELECT
        s.workspace_id,
        a.status,
        COUNT(*)::text as count
      FROM agent_sessions a
      JOIN streams s ON a.stream_id = s.id
      WHERE a.created_at > NOW() - INTERVAL '24 hours'
      GROUP BY s.workspace_id, a.status
    `)

    for (const row of countResult.rows) {
      agentSessionsActive.set({ workspace_id: row.workspace_id, status: row.status }, parseInt(row.count, 10))
    }

    if (this.lastCollectedAt) {
      const durationResult = await this.pool.query<CompletedSessionRow>(sql`
        SELECT
          s.workspace_id,
          a.status,
          EXTRACT(EPOCH FROM (a.completed_at - a.created_at)) as duration_seconds
        FROM agent_sessions a
        JOIN streams s ON a.stream_id = s.id
        WHERE a.completed_at IS NOT NULL
          AND a.completed_at > ${this.lastCollectedAt}
          AND a.status IN ('completed', 'failed', 'deleted', 'superseded')
      `)

      for (const row of durationResult.rows) {
        agentSessionDuration.observe(
          { workspace_id: row.workspace_id, status: row.status },
          parseFloat(row.duration_seconds)
        )
      }
    }

    this.lastCollectedAt = now
  }
}
