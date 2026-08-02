import { Registry, Gauge, Counter, Histogram } from "prom-client"

// Dedicated registry, not prom-client's default.
export const registry = new Registry()

export const poolConnectionsTotal = new Gauge({
  name: "pool_connections_total",
  help: "Total number of connections in the pool",
  labelNames: ["pool"],
  registers: [registry],
})

export const poolConnectionsIdle = new Gauge({
  name: "pool_connections_idle",
  help: "Number of idle connections in the pool",
  labelNames: ["pool"],
  registers: [registry],
})

export const poolConnectionsWaiting = new Gauge({
  name: "pool_connections_waiting",
  help: "Number of clients waiting for a connection",
  labelNames: ["pool"],
  registers: [registry],
})

export const poolUtilizationPercent = new Gauge({
  name: "pool_utilization_percent",
  help: "Pool utilization as a percentage (0-100)",
  labelNames: ["pool"],
  registers: [registry],
})

export const queueMessagesEnqueued = new Counter({
  name: "queue_messages_enqueued_total",
  help: "Total number of messages enqueued",
  labelNames: ["queue", "workspace_id"],
  registers: [registry],
})

export const queueMessagesInFlight = new Gauge({
  name: "queue_messages_in_flight",
  help: "Number of messages currently being processed",
  labelNames: ["queue"],
  registers: [registry],
})

export const queueMessagesProcessed = new Counter({
  name: "queue_messages_processed_total",
  help: "Total number of queue messages processed",
  labelNames: ["queue", "status", "workspace_id"], // status: success | failed | dlq
  registers: [registry],
})

export const queueMessageDuration = new Histogram({
  name: "queue_message_duration_seconds",
  help: "Duration of queue message processing in seconds",
  labelNames: ["queue", "workspace_id"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120], // 100ms to 2 minutes
  registers: [registry],
})

export const queueTokensStuck = new Counter({
  name: "queue_tokens_stuck_total",
  help: "Total number of queue tokens that exceeded the stuck warning threshold",
  labelNames: ["queue", "workspace_id"],
  registers: [registry],
})

// Labels: method, normalized_path, status_code, error_type, workspace_id
// error_type: "-" | "not_authenticated" | "forbidden" | "not_found" | "client_error" | "server_error"
export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "normalized_path", "status_code", "error_type", "workspace_id"],
  registers: [registry],
})

// Happy-path request logs are silenced (customLogLevel), so version adoption
// tracking — "who still runs an old pin" ahead of a sunset — lives here, not
// in the logs. The logs only carry version context on 4xx/5xx.
export const publicApiVersionRequests = new Counter({
  name: "public_api_version_requests_total",
  help: "Public API requests by resolved wire version and how it was resolved",
  labelNames: ["version", "source"],
  registers: [registry],
})

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "normalized_path", "status_code", "error_type", "workspace_id"],
  buckets: [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 5, 10, 20, 50], // 5ms to 50s
  registers: [registry],
})

export const httpActiveConnections = new Gauge({
  name: "http_active_connections",
  help: "Number of active HTTP connections being processed",
  registers: [registry],
})

// Room pattern normalization: ws:{workspaceId}, ws:{workspaceId}:stream:{streamId}
export const wsConnectionsActive = new Gauge({
  name: "ws_connections_active",
  help: "Number of active WebSocket connections by workspace and room pattern",
  labelNames: ["workspace_id", "room_pattern"],
  registers: [registry],
})

export const wsMessagesTotal = new Counter({
  name: "ws_messages_total",
  help: "Total number of WebSocket messages",
  labelNames: ["workspace_id", "direction", "event_type", "room_pattern"], // direction: sent | received
  registers: [registry],
})

export const wsConnectionDuration = new Histogram({
  name: "ws_connection_duration_seconds",
  help: "Duration of WebSocket connections in seconds",
  labelNames: ["workspace_id"],
  buckets: [1, 5, 10, 30, 60, 300, 600, 1800, 3600], // 1s to 1 hour
  registers: [registry],
})

export const messagesTotal = new Counter({
  name: "messages_total",
  help: "Total number of messages created",
  labelNames: ["workspace_id", "stream_type", "author_type"], // author_type: user | persona
  registers: [registry],
})

export const agentSessionsActive = new Gauge({
  name: "agent_sessions_active",
  help: "Number of agent sessions by workspace and status",
  labelNames: ["workspace_id", "status"], // status: pending | running | completed | failed | deleted | superseded
  registers: [registry],
})

export const agentSessionDuration = new Histogram({
  name: "agent_session_duration_seconds",
  help: "Duration of agent sessions in seconds",
  labelNames: ["workspace_id", "status"],
  buckets: [1, 5, 10, 30, 60, 120, 300, 600], // 1s to 10 minutes
  registers: [registry],
})

// ── Calls (voice/video) ──────────────────────────────────────────────────────
// Day-1 operational health for the media plane (docs/features/calls.md §Observability).
// CF Realtime is a hard dependency (every call dies with a CF outage), so
// session-create success/latency and connect-failure-by-code are the first
// signals; time-to-join, end reasons, ring outcomes, and sweep counts cover the
// lifecycle. Labels stay low-cardinality (no workspace_id) — these are fleet
// health, not per-tenant billing.

export const callCfSessionCreateTotal = new Counter({
  name: "call_cf_session_create_total",
  help: "CF Realtime SFU session-create attempts by outcome",
  labelNames: ["status"], // success | error
  registers: [registry],
})

export const callCfSessionCreateDuration = new Histogram({
  name: "call_cf_session_create_duration_seconds",
  help: "CF Realtime SFU session-create latency in seconds",
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10], // 50ms to 10s
  registers: [registry],
})

export const callCfErrorsTotal = new Counter({
  name: "call_cf_errors_total",
  help: "CF Realtime proxy call failures by operation and CF error code",
  // operation: session_create | publish_tracks | pull_tracks | renegotiate | close_tracks
  // cf_code: the CloudflareRealtimeError.code (CF_TIMEOUT | CF_HTTP_ERROR | CF_TRANSPORT_ERROR | ...)
  labelNames: ["operation", "cf_code"],
  registers: [registry],
})

export const callTimeToJoinSeconds = new Histogram({
  name: "call_time_to_join_seconds",
  help: "Server-side time from endpoint admission (join) to CF session creation (connected)",
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30], // 100ms to 30s
  registers: [registry],
})

export const callEndedTotal = new Counter({
  name: "call_ended_total",
  help: "Calls ended by reason",
  labelNames: ["reason"], // completed | reaped
  registers: [registry],
})

export const callRingOutcomesTotal = new Counter({
  name: "call_ring_outcomes_total",
  help: "Call ring (invitation) attempts settled by outcome",
  labelNames: ["outcome"], // accepted | declined | cancelled | expired | superseded
  registers: [registry],
})

export const callSweepReapedTotal = new Counter({
  name: "call_sweep_reaped_total",
  help: "Rows reaped by the call lease sweeper by kind",
  labelNames: ["kind"], // endpoint | participant | grace_call | expired_ring
  registers: [registry],
})

// ── Queue depth ──────────────────────────────────────────────────────────────
// Sampled from queue_messages by QueueDepthSampler, not incremented at the call
// site: in-flight counters answer "is work moving", these answer "is work
// piling up". No workspace_id — fleet health.

export const queueMessagesPending = new Gauge({
  name: "queue_messages_pending",
  help: "Claimable queue messages waiting to be processed",
  labelNames: ["queue"],
  registers: [registry],
})

export const queueOldestPendingAgeSeconds = new Gauge({
  name: "queue_oldest_pending_age_seconds",
  help: "Age in seconds of the oldest claimable queue message",
  labelNames: ["queue"],
  registers: [registry],
})

export const queueMessagesDlq = new Gauge({
  name: "queue_messages_dlq",
  help: "Queue messages currently sitting in the dead-letter queue",
  labelNames: ["queue"],
  registers: [registry],
})

// ── Outbox dispatch ──────────────────────────────────────────────────────────

export const outboxBatchSize = new Histogram({
  name: "outbox_batch_size",
  help: "Number of outbox events fetched per broadcast batch",
  buckets: [1, 5, 10, 25, 50, 100],
  registers: [registry],
})

export const outboxDispatchLagSeconds = new Histogram({
  name: "outbox_dispatch_lag_seconds",
  help: "Seconds between an outbox event's creation and its socket emit",
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
})

export const outboxBatchProcessSeconds = new Histogram({
  name: "outbox_batch_process_seconds",
  help: "Seconds from broadcast-handler batch entry to the last emit of that batch",
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
})

export const outboxEventsEmitted = new Counter({
  name: "outbox_events_emitted_total",
  help: "Total number of outbox events emitted by the broadcast handler",
  labelNames: ["event_type"],
  registers: [registry],
})

// ── Sync catch-up serve ──────────────────────────────────────────────────────

export const syncCatchupEntriesReturned = new Histogram({
  name: "sync_catchup_entries_returned",
  help: "Entries returned by a sync catch-up serve",
  labelNames: ["requires_bootstrap"],
  buckets: [0, 1, 10, 50, 100, 200, 500],
  registers: [registry],
})

export const syncCatchupPayloadBytes = new Histogram({
  name: "sync_catchup_payload_bytes",
  help: "Serialized response size of a sync catch-up serve in bytes",
  buckets: [1e3, 1e4, 5e4, 1e5, 5e5, 1e6, 5e6],
  registers: [registry],
})

export const syncCatchupDurationSeconds = new Histogram({
  name: "sync_catchup_duration_seconds",
  help: "Duration of a sync catch-up serve in seconds",
  buckets: [0.005, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
})

// ── Bootstrap serve ──────────────────────────────────────────────────────────

export const bootstrapServePayloadBytes = new Histogram({
  name: "bootstrap_serve_payload_bytes",
  help: "Serialized response size of a bootstrap serve in bytes",
  labelNames: ["kind"], // workspace | stream
  buckets: [1e3, 1e4, 5e4, 1e5, 5e5, 1e6, 5e6],
  registers: [registry],
})

export const bootstrapServeDurationSeconds = new Histogram({
  name: "bootstrap_serve_duration_seconds",
  help: "Duration of a bootstrap serve in seconds",
  labelNames: ["kind"],
  buckets: [0.005, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
})

export const bootstrapServeEntitiesReturned = new Histogram({
  name: "bootstrap_serve_entities_returned",
  help: "Top-level entities returned by a bootstrap serve",
  labelNames: ["kind"],
  buckets: [0, 10, 50, 100, 250, 500, 1000, 5000],
  registers: [registry],
})

/** Collect prom-client default metrics (process stats, memory, etc.). */
export function collectDefaultMetrics() {
  const promClient = require("prom-client")
  promClient.collectDefaultMetrics({ register: registry })
}
