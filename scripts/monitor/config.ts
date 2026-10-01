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
  /** `logs` has no deploy baseline to anchor to, so it defaults to this much history. */
  logsDefaultSinceMs: 60 * 60 * 1000,
  /** Railway log page sizes (the API caps around 5000). */
  logFetchLimit: 1_000,
  /**
   * Push thresholds are initial conservative picks, not calibrated against
   * production traffic. Provider failures: below this many terminal device
   * deliveries with a provider answer, a rate is noise.
   */
  pushTransportMinSample: 20,
  /** Share of those that ended rejected, or unreachable until attempts or the send window ran out. */
  pushTransportFailureRate: 0.1,
  /** A due delivery still unsettled this long means push workers are not finishing it (matches queueReadyAgeWarnSec). */
  pushBacklogOverdueSec: 5 * 60,
  /**
   * Receipt cohorts are selected by capability expiry, so each window is closed.
   * One day each for current and baseline: a message push's TTL is 24h, so a
   * delivery matures about a day after it was sent.
   */
  pushReceiptCohortWindowMs: 24 * 60 * 60 * 1000,
  /** Below this many eligible deliveries a window is insufficient evidence: no finding, never "healthy". At 30 the 95% interval is about ±15 points. */
  pushReceiptMinSample: 30,
  /** Warn when even the 95% upper bound of the confirmed share is below this: offline devices alone should not get there. */
  pushReceiptFloor: 0.5,
  /** Warn on a drop only when the intervals do not overlap AND the point estimate fell at least this much. */
  pushReceiptDropPoints: 0.15,
  /** Share of confirmed deliveries whose worker reported notification creation failed. */
  pushCreationFailedRate: 0.1,
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
