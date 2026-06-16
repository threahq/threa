import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test"
import { isLangfuseEnabled } from "./langfuse"

describe("langfuse", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.LANGFUSE_SECRET_KEY
    delete process.env.LANGFUSE_PUBLIC_KEY
    delete process.env.LANGFUSE_BASE_URL
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  describe("isLangfuseEnabled", () => {
    test("should return false when no env vars are set", () => {
      expect(isLangfuseEnabled()).toBe(false)
    })

    test("should return false when only secret key is set", () => {
      process.env.LANGFUSE_SECRET_KEY = "sk-lf-test"
      expect(isLangfuseEnabled()).toBe(false)
    })

    test("should return false when only public key is set", () => {
      process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test"
      expect(isLangfuseEnabled()).toBe(false)
    })

    test("should return true when both keys are set", () => {
      process.env.LANGFUSE_SECRET_KEY = "sk-lf-test"
      process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test"
      expect(isLangfuseEnabled()).toBe(true)
    })
  })
})
