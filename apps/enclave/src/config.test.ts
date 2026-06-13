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
