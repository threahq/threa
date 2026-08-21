/**
 * Production monitoring knobs. Thresholds are repository facts (INV-44 spirit):
 * change them here, never in a skill or chat.
 */
export const PROD = {
  frontendUrl: "https://app.threa.io",
  githubRepo: "threahq/threa",
  /** Railway services whose deployments carry a git sha we expect to match main. */
  revisionServices: ["backend", "control-plane", "enclave", "db-read-proxy"] as const,
  /** Railway services whose logs matter for app health (Postgres logs every statement as stderr noise). */
  logServices: ["backend", "control-plane", "enclave", "db-read-proxy"] as const,
  /** GitHub workflows that gate a frontend rollout, in order. */
  frontendWorkflows: { ci: "CI", deploy: "Deploy Cloudflare" },
  /** Prod workspace used for the authenticated public-API smoke when env gives none. */
  smokeWorkspaceEnv: "THREA_PROD_DEFAULT_WORKSPACE",
} as const

export const THRESHOLDS = {
  /** HTTP probe latency above this is a warning. */
  slowHttpMs: 2_000,
  /** Outbox listener cursor this many events behind head is a warning. */
  outboxLagWarn: 500,
  /** Listener that has not advanced for this long is reported as stale, not lagging. */
  listenerStaleMs: 6 * 60 * 60 * 1000,
  /** Oldest ready-but-unclaimed queue message older than this is a warning. */
  queueReadyAgeWarnSec: 5 * 60,
  /** Running agent session with a heartbeat older than this is stuck. */
  agentHeartbeatStaleSec: 5 * 60,
  /** Current memory above this multiple of the prior window's peak warns (sustained growth, not rollover). */
  memoryGrowthWarnMultiplier: 1.5,
  cpuGrowthWarnMultiplier: 2,
  /** Error log lines since baseline exceeding this multiple of the prior window warn. */
  logRateWarnMultiplier: 2,
  /** Below this many prior-window lines the multiplier is meaningless; use an absolute floor. */
  logRateAbsoluteFloor: 10,
  /** Since-deploy window floor: a deploy 2 minutes ago compares against at least this much history. */
  minWindowMs: 30 * 60 * 1000,
  /** `verify` polling. */
  verifyIntervalMs: 60_000,
  verifyTimeoutMs: 40 * 60 * 1000,
  /** `watch` polling. */
  watchIntervalMs: 5 * 60 * 1000,
  watchDurationMs: 60 * 60 * 1000,
  /** Railway log page sizes (the API caps around 5000). */
  logFetchLimit: 1_000,
} as const

/**
 * Log lines matched here are counted separately as "known noise" so they never
 * trip the rate alarm. Each entry carries why it is noise.
 */
export const KNOWN_LOG_NOISE: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  {
    pattern: /DeprecationWarning: Calling client\.query\(\) when the client is already executing/,
    why: "pg@8 deprecation printed once per boot",
  },
  { pattern: /Use `bun --trace-warnings/, why: "second line of the same node warning" },
]

/**
 * Outbox listener rows left behind by removed listeners. They never advance, so they are
 * reported as decommissioned rather than as a stale worker. Drop an entry when its row goes.
 */
export const DECOMMISSIONED_LISTENERS: ReadonlyArray<{ id: string; why: string }> = [
  { id: "naming", why: "superseded by dynamic-naming; listener removed in 191c49cc (#1807)" },
]

export const CREDENTIAL_KEYS = [
  "RAILWAY_READONLY_TOKEN",
  "DB_READ_PROXY_URL",
  "DB_READ_PROXY_SECRET",
  "THREA_PROD_BASE_URL",
  "THREA_PROD_READ_ONLY_API_KEY",
  "THREA_PROD_DEFAULT_WORKSPACE",
] as const
export type CredentialKey = (typeof CREDENTIAL_KEYS)[number]
export const AGENT_ENV_FILE = "~/.threa.env.agents"
