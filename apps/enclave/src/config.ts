import { ARIADNE_AGENT_ID } from "@threa/types"

export interface EnclaveConfig {
  port: number
  /** URL that other services use to reach this instance's /invoke endpoint. */
  selfUrl: string
  /** Backend base URL — target for register/heartbeat/revoke. */
  backendBaseUrl: string
  /** Shared secret used both for backend-to-enclave invoke auth and enclave-to-backend internal calls. */
  internalApiKey: string
  /** OpenRouter API key forwarded into the AI wrapper. */
  openRouterApiKey: string
  /** Heartbeat interval. Backend's staleness window is 2min, so 30s keeps us with 3 retries of grace. */
  heartbeatIntervalMs: number
  /** Hard-coded persona allowlist for 5a — only Ariadne. Plain-text comparison against `persona.id`. */
  allowedPersonaIds: string[]
}

export function loadEnclaveConfig(): EnclaveConfig {
  const required = ["INTERNAL_API_KEY", "BACKEND_BASE_URL", "OPENROUTER_API_KEY", "ENCLAVE_SELF_URL"]
  const missing = required.filter((k) => !process.env[k])
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`)
  }

  return {
    port: Number(process.env.PORT) || 3011,
    selfUrl: process.env.ENCLAVE_SELF_URL!,
    backendBaseUrl: process.env.BACKEND_BASE_URL!.replace(/\/$/, ""),
    internalApiKey: process.env.INTERNAL_API_KEY!,
    openRouterApiKey: process.env.OPENROUTER_API_KEY!,
    heartbeatIntervalMs: Number(process.env.ENCLAVE_HEARTBEAT_INTERVAL_MS) || 30_000,
    allowedPersonaIds: [ARIADNE_AGENT_ID],
  }
}
