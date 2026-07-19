import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { loadConfig } from "./env"
import { logger } from "./logger"

const ORIGINAL_ENV = { ...process.env }

function resetEnv() {
  process.env = { ...ORIGINAL_ENV }
}

function setBaseEnv() {
  process.env.DATABASE_URL = "postgres://localhost:5432/threa_test"
  delete process.env.GITHUB_APP_ID
  delete process.env.GITHUB_APP_SLUG
  delete process.env.GITHUB_APP_PRIVATE_KEY
  delete process.env.WORKSPACE_INTEGRATIONS_SECRET
  delete process.env.MEDIACONVERT_ENABLED
  delete process.env.MEDIACONVERT_ROLE_ARN
  delete process.env.MEDIACONVERT_ENDPOINT
  delete process.env.INTERNAL_API_KEY
  delete process.env.ENCLAVE_INTERNAL_API_KEY
  delete process.env.CONTROL_PLANE_URL
  delete process.env.REGION
}

afterEach(() => {
  resetEnv()
})

describe("loadConfig stub auth safety", () => {
  test("throws when stub auth is enabled in production", () => {
    setBaseEnv()
    process.env.NODE_ENV = "production"
    process.env.USE_STUB_AUTH = "true"
    process.env.CORS_ALLOWED_ORIGINS = "https://app.example.com"

    expect(() => loadConfig()).toThrow("USE_STUB_AUTH must be false in production")
  })

  test("allows stub auth outside production", () => {
    setBaseEnv()
    process.env.NODE_ENV = "development"
    process.env.USE_STUB_AUTH = "true"

    const config = loadConfig()
    expect(config.useStubAuth).toBe(true)
  })

  test("requires explicit CORS allowlist in production", () => {
    setBaseEnv()
    process.env.NODE_ENV = "production"
    process.env.USE_STUB_AUTH = "false"
    process.env.WORKOS_API_KEY = "key"
    process.env.WORKOS_CLIENT_ID = "client"
    process.env.WORKOS_REDIRECT_URI = "https://app.example.com/callback"
    process.env.WORKOS_COOKIE_PASSWORD = "password"

    expect(() => loadConfig()).toThrow("CORS_ALLOWED_ORIGINS is required in production")
  })
})

describe("loadConfig S3 residency (INV-11)", () => {
  test("requires S3_REGION in production", () => {
    setBaseEnv()
    delete process.env.S3_REGION
    process.env.NODE_ENV = "production"
    process.env.USE_STUB_AUTH = "false"
    process.env.WORKOS_API_KEY = "key"
    process.env.WORKOS_CLIENT_ID = "client"
    process.env.WORKOS_REDIRECT_URI = "https://app.example.com/callback"
    process.env.WORKOS_COOKIE_PASSWORD = "password"
    process.env.CORS_ALLOWED_ORIGINS = "https://app.example.com"

    expect(() => loadConfig()).toThrow("S3_REGION is required in production")
  })

  test("falls back to us-east-1 outside production", () => {
    setBaseEnv()
    delete process.env.S3_REGION
    process.env.NODE_ENV = "development"
    process.env.USE_STUB_AUTH = "true"

    const config = loadConfig()
    expect(config.s3.region).toBe("us-east-1")
  })
})

describe("loadConfig attachment safety policy", () => {
  test("enables malware scan by default", () => {
    setBaseEnv()
    process.env.NODE_ENV = "development"
    process.env.USE_STUB_AUTH = "true"

    const config = loadConfig()
    expect(config.attachments.malwareScanEnabled).toBe(true)
  })

  test("allows disabling malware scan via env", () => {
    setBaseEnv()
    process.env.NODE_ENV = "development"
    process.env.USE_STUB_AUTH = "true"
    process.env.ATTACHMENT_MALWARE_SCAN_ENABLED = "false"

    const config = loadConfig()
    expect(config.attachments.malwareScanEnabled).toBe(false)
  })
})

describe("loadConfig workspace creation invite policy", () => {
  test("defaults workspace creation invite requirement to enabled", () => {
    setBaseEnv()
    process.env.NODE_ENV = "development"
    process.env.USE_STUB_AUTH = "true"

    const config = loadConfig()
    expect(config.workspaceCreationRequiresInvite).toBe(true)
  })

  test("allows disabling workspace creation invite requirement when configured", () => {
    setBaseEnv()
    process.env.NODE_ENV = "development"
    process.env.USE_STUB_AUTH = "true"
    process.env.WORKSPACE_CREATION_SKIP_INVITE = "true"

    const config = loadConfig()
    expect(config.workspaceCreationRequiresInvite).toBe(false)
  })

  test("logs warning when stub auth is used with invite requirement enabled", () => {
    setBaseEnv()
    process.env.NODE_ENV = "development"
    process.env.USE_STUB_AUTH = "true"

    const warnSpy = spyOn(logger, "warn")

    loadConfig()

    expect(warnSpy).toHaveBeenCalledWith(
      "USE_STUB_AUTH is enabled while workspace creation invite checks are enabled; stub auth cannot verify WorkOS invites and will allow workspace creation. Set WORKSPACE_CREATION_SKIP_INVITE=true to make the bypass explicit."
    )
    warnSpy.mockRestore()
  })
})

describe("loadConfig github app configuration", () => {
  test("disables GitHub integration config when no GitHub env vars are set", () => {
    setBaseEnv()
    process.env.NODE_ENV = "development"
    process.env.USE_STUB_AUTH = "true"

    const config = loadConfig()
    expect(config.github.enabled).toBe(false)
  })

  test("throws on partial GitHub integration configuration", () => {
    setBaseEnv()
    process.env.NODE_ENV = "development"
    process.env.USE_STUB_AUTH = "true"
    process.env.GITHUB_APP_ID = "12345"

    expect(() => loadConfig()).toThrow(
      "GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY, and WORKSPACE_INTEGRATIONS_SECRET must all be set together"
    )
  })

  test("requires a control-plane destination for regional GitHub in production", () => {
    setBaseEnv()
    process.env.NODE_ENV = "production"
    process.env.S3_REGION = "eu-north-1"
    process.env.USE_STUB_AUTH = "false"
    process.env.CORS_ALLOWED_ORIGINS = "https://app.example.com"
    process.env.WORKOS_API_KEY = "key"
    process.env.WORKOS_CLIENT_ID = "client"
    process.env.WORKOS_REDIRECT_URI = "https://app.example.com/callback"
    process.env.WORKOS_COOKIE_PASSWORD = "password"
    process.env.GITHUB_APP_ID = "12345"
    process.env.GITHUB_APP_SLUG = "threa-prod"
    process.env.GITHUB_APP_PRIVATE_KEY = "private-key"
    process.env.WORKSPACE_INTEGRATIONS_SECRET = "test-secret"
    process.env.REGION = "eu-north-1"

    expect(() => loadConfig()).toThrow(
      "CONTROL_PLANE_URL is required for a regional production backend with GitHub enabled"
    )
  })

  test("throws when GitHub is enabled in production with neither control plane nor region", () => {
    setBaseEnv()
    process.env.NODE_ENV = "production"
    process.env.S3_REGION = "eu-north-1"
    process.env.USE_STUB_AUTH = "false"
    process.env.CORS_ALLOWED_ORIGINS = "https://app.example.com"
    process.env.WORKOS_API_KEY = "key"
    process.env.WORKOS_CLIENT_ID = "client"
    process.env.WORKOS_REDIRECT_URI = "https://app.example.com/callback"
    process.env.WORKOS_COOKIE_PASSWORD = "password"
    process.env.GITHUB_APP_ID = "12345"
    process.env.GITHUB_APP_SLUG = "threa-prod"
    process.env.GITHUB_APP_PRIVATE_KEY = "private-key"
    process.env.WORKSPACE_INTEGRATIONS_SECRET = "test-secret"

    expect(() => loadConfig()).toThrow(
      "REGION and CONTROL_PLANE_URL are required for a production backend with GitHub enabled"
    )
  })

  test("keeps the precise REGION-missing message when only CONTROL_PLANE_URL is set", () => {
    setBaseEnv()
    process.env.NODE_ENV = "production"
    process.env.S3_REGION = "eu-north-1"
    process.env.USE_STUB_AUTH = "false"
    process.env.CORS_ALLOWED_ORIGINS = "https://app.example.com"
    process.env.WORKOS_API_KEY = "key"
    process.env.WORKOS_CLIENT_ID = "client"
    process.env.WORKOS_REDIRECT_URI = "https://app.example.com/callback"
    process.env.WORKOS_COOKIE_PASSWORD = "password"
    process.env.GITHUB_APP_ID = "12345"
    process.env.GITHUB_APP_SLUG = "threa-prod"
    process.env.GITHUB_APP_PRIVATE_KEY = "private-key"
    process.env.WORKSPACE_INTEGRATIONS_SECRET = "test-secret"
    process.env.CONTROL_PLANE_URL = "https://cp.example.com"

    expect(() => loadConfig()).toThrow("REGION is required when CONTROL_PLANE_URL is set")
  })

  test("boots when GitHub is enabled in production with both control plane and region", () => {
    setBaseEnv()
    process.env.NODE_ENV = "production"
    process.env.S3_REGION = "eu-north-1"
    process.env.USE_STUB_AUTH = "false"
    process.env.CORS_ALLOWED_ORIGINS = "https://app.example.com"
    process.env.WORKOS_API_KEY = "key"
    process.env.WORKOS_CLIENT_ID = "client"
    process.env.WORKOS_REDIRECT_URI = "https://app.example.com/callback"
    process.env.WORKOS_COOKIE_PASSWORD = "password"
    process.env.GITHUB_APP_ID = "12345"
    process.env.GITHUB_APP_SLUG = "threa-prod"
    process.env.GITHUB_APP_PRIVATE_KEY = "private-key"
    process.env.WORKSPACE_INTEGRATIONS_SECRET = "test-secret"
    process.env.REGION = "eu-north-1"
    process.env.CONTROL_PLANE_URL = "https://cp.example.com"
    process.env.INTERNAL_API_KEY = "internal-key"
    process.env.ENCLAVE_INTERNAL_API_KEY = "enclave-key"

    const config = loadConfig()
    expect(config.github.enabled).toBe(true)
    expect(config.region).toBe("eu-north-1")
    expect(config.controlPlaneUrl).toBe("https://cp.example.com")
  })

  test("boots when GitHub is enabled outside production with neither control plane nor region", () => {
    setBaseEnv()
    process.env.NODE_ENV = "development"
    process.env.USE_STUB_AUTH = "true"
    process.env.GITHUB_APP_ID = "12345"
    process.env.GITHUB_APP_SLUG = "threa-dev"
    process.env.GITHUB_APP_PRIVATE_KEY = "private-key"
    process.env.WORKSPACE_INTEGRATIONS_SECRET = "test-secret"

    const config = loadConfig()
    expect(config.github.enabled).toBe(true)
    expect(config.region).toBeNull()
    expect(config.controlPlaneUrl).toBeNull()
  })

  test("normalizes escaped newlines in the GitHub App private key", () => {
    setBaseEnv()
    process.env.NODE_ENV = "development"
    process.env.USE_STUB_AUTH = "true"
    process.env.GITHUB_APP_ID = "12345"
    process.env.GITHUB_APP_SLUG = "threa-dev"
    process.env.GITHUB_APP_PRIVATE_KEY = "line1\\nline2"
    process.env.WORKSPACE_INTEGRATIONS_SECRET = "test-secret"

    const config = loadConfig()
    expect(config.github.enabled).toBe(true)
    expect(config.github.privateKey).toBe("line1\nline2")
  })
})

describe("loadConfig MediaConvert configuration", () => {
  test("disables MediaConvert when no MediaConvert env vars are set", () => {
    setBaseEnv()
    process.env.NODE_ENV = "development"
    process.env.USE_STUB_AUTH = "true"

    const config = loadConfig()
    expect(config.mediaConvert.enabled).toBe(false)
  })

  test("throws when MediaConvert is enabled without a role ARN", () => {
    setBaseEnv()
    process.env.NODE_ENV = "development"
    process.env.USE_STUB_AUTH = "true"
    process.env.MEDIACONVERT_ENABLED = "true"

    expect(() => loadConfig()).toThrow("MEDIACONVERT_ROLE_ARN is required when MEDIACONVERT_ENABLED=true")
  })

  test("throws when MediaConvert role ARN is set but transcoding is disabled", () => {
    setBaseEnv()
    process.env.NODE_ENV = "development"
    process.env.USE_STUB_AUTH = "true"
    process.env.MEDIACONVERT_ROLE_ARN = "arn:aws:iam::123456789012:role/threa-mediaconvert-dev"

    expect(() => loadConfig()).toThrow(
      "MEDIACONVERT_ENABLED=true is required when MediaConvert role ARN or endpoint is configured"
    )
  })

  test("loads MediaConvert config when enabled with a role ARN", () => {
    setBaseEnv()
    process.env.NODE_ENV = "development"
    process.env.USE_STUB_AUTH = "true"
    process.env.MEDIACONVERT_ENABLED = "true"
    process.env.MEDIACONVERT_ROLE_ARN = "arn:aws:iam::123456789012:role/threa-mediaconvert-dev"

    const config = loadConfig()
    expect(config.mediaConvert.enabled).toBe(true)
    expect(config.mediaConvert.roleArn).toBe("arn:aws:iam::123456789012:role/threa-mediaconvert-dev")
  })
})

describe("loadConfig enclave credential separation (Phase 2.4c, E2EE-22)", () => {
  test("reads the dedicated key and never falls back to INTERNAL_API_KEY", () => {
    setBaseEnv()
    process.env.NODE_ENV = "development"
    process.env.USE_STUB_AUTH = "true"
    process.env.INTERNAL_API_KEY = "shared-key"
    process.env.ENCLAVE_INTERNAL_API_KEY = "enclave-key"

    const config = loadConfig()
    expect(config.internalApiKey).toBe("shared-key")
    expect(config.enclaveInternalApiKey).toBe("enclave-key")
  })

  test("stays null when only the shared key is set — the enclave channel is then off", () => {
    setBaseEnv()
    process.env.NODE_ENV = "development"
    process.env.USE_STUB_AUTH = "true"
    process.env.INTERNAL_API_KEY = "shared-key"

    const config = loadConfig()
    expect(config.enclaveInternalApiKey).toBeNull()
  })

  test("throws when CONTROL_PLANE_URL is set without the dedicated key (INV-11)", () => {
    setBaseEnv()
    process.env.NODE_ENV = "development"
    process.env.USE_STUB_AUTH = "true"
    process.env.CONTROL_PLANE_URL = "http://localhost:3003"
    process.env.REGION = "local"
    process.env.INTERNAL_API_KEY = "shared-key"

    expect(() => loadConfig()).toThrow("ENCLAVE_INTERNAL_API_KEY is required when CONTROL_PLANE_URL is set")
  })
})
