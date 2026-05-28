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
}

export function loadEnclaveConfig(): EnclaveConfig {
  const required = ["INTERNAL_API_KEY", "BACKEND_BASE_URL", "ENCLAVE_SELF_URL"]
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
  }
}
