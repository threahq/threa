import { afterEach, describe, expect, it } from "vitest"
import { loadEnclaveConfig } from "./config"

const ORIGINAL_ENV = { ...process.env }

function setBaseEnv() {
  process.env.BACKEND_BASE_URL = "https://backend.internal"
  process.env.ENCLAVE_SELF_URL = "https://enclave.internal"
  process.env.OPENROUTER_API_KEY = "sk-test"
  delete process.env.INTERNAL_API_KEY
  delete process.env.ENCLAVE_INTERNAL_API_KEY
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("loadEnclaveConfig credential resolution (Phase 2.4c, E2EE-22)", () => {
  it("prefers ENCLAVE_INTERNAL_API_KEY over the shared key", () => {
    setBaseEnv()
    process.env.ENCLAVE_INTERNAL_API_KEY = "enclave-key"
    process.env.INTERNAL_API_KEY = "shared-key"

    expect(loadEnclaveConfig().internalApiKey).toBe("enclave-key")
  })

  it("falls back to INTERNAL_API_KEY when the dedicated key is absent (rollout phase)", () => {
    setBaseEnv()
    process.env.INTERNAL_API_KEY = "shared-key"

    expect(loadEnclaveConfig().internalApiKey).toBe("shared-key")
  })

  it("throws when neither key is set", () => {
    setBaseEnv()

    expect(() => loadEnclaveConfig()).toThrow("ENCLAVE_INTERNAL_API_KEY")
  })
})
