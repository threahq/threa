export interface EnclaveConfig {
  port: number
  /** URL the backend stores as this instance's reachable address (registration `instanceUrl`). */
  selfUrl: string
  /** Backend base URL — target for register/heartbeat/revoke. */
  backendBaseUrl: string
  /** Shared secret for the enclave's calls to /internal/enclave-runtimes/*. */
  internalApiKey: string
  /** Heartbeat interval. Backend's staleness window is 2min, so 30s keeps us with 3 retries of grace. */
  heartbeatIntervalMs: number
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

export function loadEnclaveConfig(): EnclaveConfig {
  const required = ["INTERNAL_API_KEY", "BACKEND_BASE_URL", "ENCLAVE_SELF_URL", "OPENROUTER_API_KEY"]
  const missing = required.filter((k) => !process.env[k])
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`)
  }

  return {
    port: Number(process.env.PORT) || 3011,
    selfUrl: process.env.ENCLAVE_SELF_URL!,
    backendBaseUrl: process.env.BACKEND_BASE_URL!.replace(/\/$/, ""),
    internalApiKey: process.env.INTERNAL_API_KEY!,
    heartbeatIntervalMs: Number(process.env.ENCLAVE_HEARTBEAT_INTERVAL_MS) || 30_000,
    sourceCommitSha: process.env.GIT_SHA || "unknown",
    buildHash: process.env.BUILD_HASH || "unknown",
    openRouterApiKey: process.env.OPENROUTER_API_KEY!,
    openRouterBaseUrl: (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, ""),
    tavilyApiKey: process.env.TAVILY_API_KEY || undefined,
  }
}
