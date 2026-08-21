import { THRESHOLDS } from "../config"
import type { ReadProxyClient } from "../db"
import type { Finding, Window } from "../types"

export interface ListenerRow {
  listener_id: string
  lag: number
  last_processed_at: string | null
  retry_count: number
  last_error: string | null
}

export interface QueueRow {
  queue_name: string
  running: number
  ready: number
  scheduled: number
  oldest_ready_sec: number | null
  dlq_since: number
  dlq_prior: number
  done_since: number
  done_prior: number
}

export interface CounterRow {
  metric: string
  since: number
  prior: number
}

export interface PipelineReport {
  outbox: { head: number; listeners: ListenerRow[] }
  deadLetters: { since: number; prior: number }
  queues: QueueRow[]
  counters: CounterRow[]
  findings: Finding[]
}

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v))

export async function probePipelines(db: ReadProxyClient, window: Window): Promise<PipelineReport> {
  const [head, listeners, dead, queues, counters] = await Promise.all([
    db.rows<{ head: string }>("SELECT COALESCE(max(id), 0) AS head FROM outbox"),
    db.rows<ListenerRow>(
      `SELECT l.listener_id,
              (SELECT COALESCE(max(id), 0) FROM outbox) - l.last_processed_id AS lag,
              l.last_processed_at, l.retry_count, left(l.last_error, 200) AS last_error
         FROM outbox_listeners l
        ORDER BY lag DESC, l.listener_id`
    ),
    db.rows<{ since: string; prior: string }>(
      `SELECT count(*) FILTER (WHERE failed_at >= $1) AS since,
              count(*) FILTER (WHERE failed_at >= $2 AND failed_at < $1) AS prior
         FROM outbox_dead_letters WHERE failed_at >= $2`,
      [window.since, window.priorStart]
    ),
    db.rows<QueueRow>(
      `SELECT queue_name,
              count(*) FILTER (WHERE completed_at IS NULL AND cancelled_at IS NULL AND dlq_at IS NULL AND claimed_until > NOW()) AS running,
              count(*) FILTER (WHERE completed_at IS NULL AND cancelled_at IS NULL AND dlq_at IS NULL AND (claimed_until IS NULL OR claimed_until <= NOW()) AND process_after <= NOW()) AS ready,
              count(*) FILTER (WHERE completed_at IS NULL AND cancelled_at IS NULL AND dlq_at IS NULL AND process_after > NOW()) AS scheduled,
              EXTRACT(EPOCH FROM (NOW() - min(process_after) FILTER (WHERE completed_at IS NULL AND cancelled_at IS NULL AND dlq_at IS NULL AND (claimed_until IS NULL OR claimed_until <= NOW()) AND process_after <= NOW())))::int AS oldest_ready_sec,
              count(*) FILTER (WHERE dlq_at >= $1) AS dlq_since,
              count(*) FILTER (WHERE dlq_at >= $2 AND dlq_at < $1) AS dlq_prior,
              count(*) FILTER (WHERE completed_at >= $1) AS done_since,
              count(*) FILTER (WHERE completed_at >= $2 AND completed_at < $1) AS done_prior
         FROM queue_messages
        WHERE completed_at IS NULL OR completed_at >= $2 OR dlq_at >= $2
        GROUP BY queue_name ORDER BY queue_name`,
      [window.since, window.priorStart]
    ),
    db.rows<CounterRow>(
      `SELECT 'agent_sessions failed' AS metric,
              count(*) FILTER (WHERE created_at >= $1) AS since,
              count(*) FILTER (WHERE created_at >= $2 AND created_at < $1) AS prior
         FROM agent_sessions WHERE status = 'failed' AND created_at >= $2
       UNION ALL
       SELECT 'agent_sessions stuck (running, heartbeat > ${THRESHOLDS.agentHeartbeatStaleSec}s)',
              count(*), 0
         FROM agent_sessions WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < NOW() - interval '${THRESHOLDS.agentHeartbeatStaleSec} seconds')
       UNION ALL
       SELECT 'agent_sessions completed',
              count(*) FILTER (WHERE created_at >= $1),
              count(*) FILTER (WHERE created_at >= $2 AND created_at < $1)
         FROM agent_sessions WHERE status = 'completed' AND created_at >= $2
       UNION ALL
       SELECT 'bot_invocations failed',
              count(*) FILTER (WHERE created_at >= $1),
              count(*) FILTER (WHERE created_at >= $2 AND created_at < $1)
         FROM bot_invocations WHERE status = 'failed' AND created_at >= $2
       UNION ALL
       SELECT 'bot_invocations completed',
              count(*) FILTER (WHERE created_at >= $1),
              count(*) FILTER (WHERE created_at >= $2 AND created_at < $1)
         FROM bot_invocations WHERE status = 'completed' AND created_at >= $2
       UNION ALL
       SELECT 'scheduled_messages failed',
              count(*) FILTER (WHERE status_changed_at >= $1),
              count(*) FILTER (WHERE status_changed_at >= $2 AND status_changed_at < $1)
         FROM scheduled_messages WHERE status = 'failed' AND status_changed_at >= $2
       UNION ALL
       SELECT 'backfill_runs failed',
              count(*) FILTER (WHERE updated_at >= $1),
              count(*) FILTER (WHERE updated_at >= $2 AND updated_at < $1)
         FROM backfill_runs WHERE status = 'failed' AND updated_at >= $2`,
      [window.since, window.priorStart]
    ),
  ])

  const report: PipelineReport = {
    outbox: {
      head: n(head[0]?.head),
      listeners: listeners.map((l) => ({ ...l, lag: n(l.lag), retry_count: n(l.retry_count) })),
    },
    deadLetters: { since: n(dead[0]?.since), prior: n(dead[0]?.prior) },
    queues: queues.map((q) => ({
      ...q,
      running: n(q.running),
      ready: n(q.ready),
      scheduled: n(q.scheduled),
      oldest_ready_sec: q.oldest_ready_sec === null ? null : n(q.oldest_ready_sec),
      dlq_since: n(q.dlq_since),
      dlq_prior: n(q.dlq_prior),
      done_since: n(q.done_since),
      done_prior: n(q.done_prior),
    })),
    counters: counters.map((c) => ({ ...c, since: n(c.since), prior: n(c.prior) })),
    findings: [],
  }
  report.findings = evaluatePipelines(report, new Date(window.now))
  return report
}

export function evaluatePipelines(report: Omit<PipelineReport, "findings">, now: Date): Finding[] {
  const findings: Finding[] = []
  for (const l of report.outbox.listeners) {
    const lastAt = l.last_processed_at ? new Date(l.last_processed_at).getTime() : 0
    const stale = now.getTime() - lastAt > THRESHOLDS.listenerStaleMs
    if (stale && l.lag > 0) {
      findings.push({
        level: "warn",
        id: `outbox.stale.${l.listener_id}`,
        message: `outbox listener ${l.listener_id} stale since ${l.last_processed_at ?? "never"} (lag ${l.lag}); decommissioned listener or dead worker?`,
      })
    } else if (l.lag > THRESHOLDS.outboxLagWarn) {
      findings.push({
        level: "warn",
        id: `outbox.lag.${l.listener_id}`,
        message: `outbox listener ${l.listener_id} is ${l.lag} events behind head`,
      })
    }
    if (l.retry_count > 0 && !stale) {
      findings.push({
        level: "warn",
        id: `outbox.retry.${l.listener_id}`,
        message: `outbox listener ${l.listener_id} retrying (${l.retry_count}): ${l.last_error ?? ""}`,
      })
    }
  }
  if (report.deadLetters.since > 0) {
    findings.push({
      level: "warn",
      id: "outbox.dlq",
      message: `${report.deadLetters.since} outbox dead letters since baseline (prior window ${report.deadLetters.prior})`,
    })
  }
  for (const q of report.queues) {
    if (q.dlq_since > 0)
      findings.push({
        level: "warn",
        id: `queue.dlq.${q.queue_name}`,
        message: `${q.queue_name}: ${q.dlq_since} moved to DLQ since baseline (prior ${q.dlq_prior})`,
      })
    if (q.ready > 0 && (q.oldest_ready_sec ?? 0) > THRESHOLDS.queueReadyAgeWarnSec) {
      findings.push({
        level: "warn",
        id: `queue.stuck.${q.queue_name}`,
        message: `${q.queue_name}: ${q.ready} ready, oldest waiting ${q.oldest_ready_sec}s; workers not claiming?`,
      })
    }
  }
  for (const c of report.counters) {
    if (!/failed|stuck/.test(c.metric)) continue
    if (c.since > 0)
      findings.push({
        level: "warn",
        id: `counter.${c.metric}`,
        message: `${c.metric}: ${c.since} since baseline (prior ${c.prior})`,
      })
  }
  return findings
}
