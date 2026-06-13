import { afterEach, describe, expect, it } from "vitest"
import { loadEnclaveConfig } from "./config"

const ORIGINAL_ENV = { ...process.env }

function setBaseEnv() {
  process.env.BACKEND_BASE_URL = "https://backend.internal"
  process.env.OPENROUTER_API_KEY = "sk-test"
  delete process.env.INTERNAL_API_KEY
  delete process.env.ENCLAVE_INTERNAL_API_KEY
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("loadEnclaveConfig credential resolution (Phase 2.4c, E2EE-22)", () => {
  it("reads ENCLAVE_INTERNAL_API_KEY, ignoring the backend's shared key", () => {
    setBaseEnv()
    process.env.ENCLAVE_INTERNAL_API_KEY = "enclave-key"
    process.env.INTERNAL_API_KEY = "shared-key"

    expect(loadEnclaveConfig().internalApiKey).toBe("enclave-key")
  })

  it("throws when the dedicated key is absent — the shared key is not a fallback", () => {
    setBaseEnv()
    process.env.INTERNAL_API_KEY = "shared-key"

    expect(() => loadEnclaveConfig()).toThrow("ENCLAVE_INTERNAL_API_KEY")
  })
})

describe("loadEnclaveConfig numeric guards", () => {
  function withKey() {
    setBaseEnv()
    process.env.ENCLAVE_INTERNAL_API_KEY = "enclave-key"
  }

  it("accepts a valid positive override", () => {
    withKey()
    process.env.ENCLAVE_CLAIM_POLL_INTERVAL_MS = "3000"

    expect(loadEnclaveConfig().claimPollIntervalMs).toBe(3000)
  })

  it("uses the documented default when the var is unset", () => {
    withKey()
    delete process.env.ENCLAVE_CLAIM_POLL_INTERVAL_MS

    expect(loadEnclaveConfig().claimPollIntervalMs).toBe(1_500)
  })

  it("throws rather than passing a negative interval to setTimeout (hot-loop guard)", () => {
    withKey()
    process.env.ENCLAVE_CLAIM_POLL_INTERVAL_MS = "-5"

    expect(() => loadEnclaveConfig()).toThrow("ENCLAVE_CLAIM_POLL_INTERVAL_MS")
  })

  it("throws on a zero override", () => {
    withKey()
    process.env.ENCLAVE_HEARTBEAT_INTERVAL_MS = "0"

    expect(() => loadEnclaveConfig()).toThrow("ENCLAVE_HEARTBEAT_INTERVAL_MS")
  })

  it("throws on a non-integer override", () => {
    withKey()
    process.env.ENCLAVE_CLAIM_POLL_INTERVAL_MS = "1.5"

    expect(() => loadEnclaveConfig()).toThrow("ENCLAVE_CLAIM_POLL_INTERVAL_MS")
  })

  it("throws on a non-numeric override", () => {
    withKey()
    process.env.ENCLAVE_MAX_CONCURRENT_SESSIONS = "lots"

    expect(() => loadEnclaveConfig()).toThrow("ENCLAVE_MAX_CONCURRENT_SESSIONS")
  })
})
