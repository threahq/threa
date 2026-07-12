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

export const queueHandlersConcurrent = new Gauge({
  name: "queue_handlers_concurrent",
  help: "Number of concurrently executing queue handlers",
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

export const cronSchedulesTotal = new Gauge({
  name: "cron_schedules_total",
  help: "Total number of active cron schedules",
  labelNames: ["queue"],
  registers: [registry],
})

export const cronTicksGenerated = new Counter({
  name: "cron_ticks_generated_total",
  help: "Total number of cron ticks generated",
  labelNames: ["queue"],
  registers: [registry],
})

export const cronTicksExecuted = new Counter({
  name: "cron_ticks_executed_total",
  help: "Total number of cron ticks executed",
  labelNames: ["queue"],
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

export const memoProcessingDuration = new Histogram({
  name: "memo_processing_duration_seconds",
  help: "Duration of memo batch processing in seconds",
  buckets: [1, 5, 10, 30, 60, 120, 300], // 1s to 5 minutes
  registers: [registry],
})

export const memoCreated = new Counter({
  name: "memo_created_total",
  help: "Total number of memos created",
  registers: [registry],
})

export const memoRevised = new Counter({
  name: "memo_revised_total",
  help: "Total number of memos revised",
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

export const aiCallsTotal = new Counter({
  name: "ai_calls_total",
  help: "Total number of AI API calls",
  labelNames: ["function", "model", "status"], // status: success | error
  registers: [registry],
})

export const aiCallDuration = new Histogram({
  name: "ai_call_duration_seconds",
  help: "AI API call duration in seconds",
  labelNames: ["function", "model"],
  buckets: [0.5, 1, 2, 5, 10, 20, 30, 60], // 500ms to 1 minute
  registers: [registry],
})

export const aiTokensUsed = new Counter({
  name: "ai_tokens_used_total",
  help: "Total number of AI tokens used",
  labelNames: ["function", "model", "type"], // type: prompt | completion
  registers: [registry],
})

/** Collect prom-client default metrics (process stats, memory, etc.). */
export function collectDefaultMetrics() {
  const promClient = require("prom-client")
  promClient.collectDefaultMetrics({ register: registry })
}
