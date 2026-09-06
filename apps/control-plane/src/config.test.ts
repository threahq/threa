import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { logger } from "@threa/backend-common"
import { loadControlPlaneConfig } from "./config"

const ORIGINAL_ENV = { ...process.env }

function resetEnv() {
  process.env = { ...ORIGINAL_ENV }
}

function setBaseEnv() {
  process.env.DATABASE_URL = "postgres://localhost:5432/threa_control_plane_test"
  process.env.INTERNAL_API_KEY = "test-internal-key"
  process.env.USE_STUB_AUTH = "true"
  delete process.env.NODE_ENV
  delete process.env.POSTHOG_PROJECT_TOKEN
  delete process.env.POSTHOG_HOST
}

afterEach(() => {
  resetEnv()
})

describe("loadControlPlaneConfig PostHog wiring", () => {
  test("should return null when neither var is set", () => {
    setBaseEnv()

    const config = loadControlPlaneConfig()
    expect(config.posthog).toBeNull()
  })

  test("should return config when both vars are set", () => {
    setBaseEnv()
    process.env.POSTHOG_PROJECT_TOKEN = "phc_test"
    process.env.POSTHOG_HOST = "https://eu.i.posthog.com"

    const config = loadControlPlaneConfig()
    expect(config.posthog).toEqual({ projectToken: "phc_test", host: "https://eu.i.posthog.com" })
  })

  test("should throw when only POSTHOG_PROJECT_TOKEN is set", () => {
    setBaseEnv()
    process.env.POSTHOG_PROJECT_TOKEN = "phc_test"

    expect(() => loadControlPlaneConfig()).toThrow("POSTHOG_HOST is required")
  })

  test("should warn once and return null when unset in production", () => {
    setBaseEnv()
    process.env.NODE_ENV = "production"
    process.env.USE_STUB_AUTH = "false"
    process.env.WORKOS_API_KEY = "key"
    process.env.WORKOS_CLIENT_ID = "client"
    process.env.WORKOS_REDIRECT_URI = "https://app.example.com/callback"
    process.env.WORKOS_COOKIE_PASSWORD = "password"
    process.env.CORS_ALLOWED_ORIGINS = "https://app.example.com"
    process.env.CLOUDFLARE_KV_ACCOUNT_ID = "account"
    process.env.CLOUDFLARE_KV_NAMESPACE_ID = "namespace"
    process.env.CLOUDFLARE_KV_API_TOKEN = "token"

    const warnSpy = spyOn(logger, "warn")

    const config = loadControlPlaneConfig()

    expect(config.posthog).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      { service: "control-plane" },
      "POSTHOG_PROJECT_TOKEN unset — error reporting to PostHog disabled"
    )

    warnSpy.mockRestore()
  })
})
