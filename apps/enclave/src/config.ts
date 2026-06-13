export interface EnclaveConfig {
  port: number
  /** Backend base URL — target for register/heartbeat/revoke/claims and the session callbacks. */
  backendBaseUrl: string
  /**
   * Dedicated secret for the enclave↔backend channel — the enclave's calls to
   * /internal/enclave-runtimes/* and the gate on the backend's inbound
   * /sessions assignment (ENCLAVE_INTERNAL_API_KEY; Phase 2.4c, E2EE-22).
   * Deliberately distinct from the backend's shared INTERNAL_API_KEY.
   */
  internalApiKey: string
  /** Heartbeat interval. Backend's staleness window is 2min, so 30s keeps us with 3 retries of grace. */
  heartbeatIntervalMs: number
  /**
   * Idle claim-poll interval (§2.7 pull transport) — the turn-start latency
   * floor when no work is flowing. A winning claim re-polls immediately.
   */
  claimPollIntervalMs: number
  /**
   * Per-instance ceiling on concurrently-running turns. Turns run detached, so
   * without a cap a backlog would let one box claim unboundedly — each in-flight
   * turn pins its history plus inline attachment ciphertext (tens of MB) in
   * memory and burns OpenRouter spend. At capacity the claim loop stops claiming
   * until a turn settles. Scaling stays "run more replicas".
   *
   * Default 8 is a conservative ceiling for a small instance: at tens of MB
   * pinned per in-flight turn, 8 keeps peak memory in the low hundreds of MB.
   * Raise it on larger boxes; lower it under memory pressure.
   */
  maxConcurrentSessions: number
  /** Source commit the image was built from, surfaced via /attestation. */
  sourceCommitSha: string
  /** Build hash of the running image, surfaced via /attestation. */
  buildHash: string
  /** OpenRouter API key — the enclave's only outbound LLM credential. */
  openRouterApiKey: string
  /** OpenRouter base URL (override for self-host; tests inject their own client). */
  openRouterBaseUrl: string
  /**
   * Tavily key for the `web_search` tool. Optional: without it the enclave runs
   * the loop with `read_url` + research only (a degraded but functional surface,
   * not a failure), so it is not in the required-vars list.
   */
  tavilyApiKey?: string
}

/**
 * Resolve an optional positive-integer env var. Unset (or empty) uses
 * `fallback`; a value that is set but not a positive integer throws rather than
 * silently degrading to the default — a malformed override is a deployment
 * mistake the operator should see at boot, not a quietly-ignored setting
 * (INV-11), and `loadEnclaveConfig` already throws for missing required vars.
 *
 * The motivating bug: `Number(env) || fallback` is truthy for a negative value,
 * so `ENCLAVE_CLAIM_POLL_INTERVAL_MS=-5` would pass straight to setTimeout
 * (clamped to 0) and turn the idle claim poll into a hot loop.
 */
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`)
  }
  return n
}

export function loadEnclaveConfig(): EnclaveConfig {
  const required = ["ENCLAVE_INTERNAL_API_KEY", "BACKEND_BASE_URL", "OPENROUTER_API_KEY"]
  const missing = required.filter((k) => !process.env[k])
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`)
  }

  return {
    port: positiveIntEnv("PORT", 3011),
    backendBaseUrl: process.env.BACKEND_BASE_URL!.replace(/\/$/, ""),
    internalApiKey: process.env.ENCLAVE_INTERNAL_API_KEY!,
    heartbeatIntervalMs: positiveIntEnv("ENCLAVE_HEARTBEAT_INTERVAL_MS", 30_000),
    claimPollIntervalMs: positiveIntEnv("ENCLAVE_CLAIM_POLL_INTERVAL_MS", 1_500),
    maxConcurrentSessions: positiveIntEnv("ENCLAVE_MAX_CONCURRENT_SESSIONS", 8),
    sourceCommitSha: process.env.GIT_SHA || "unknown",
    buildHash: process.env.BUILD_HASH || "unknown",
    openRouterApiKey: process.env.OPENROUTER_API_KEY!,
    openRouterBaseUrl: (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, ""),
    tavilyApiKey: process.env.TAVILY_API_KEY || undefined,
  }
}
