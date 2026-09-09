import { afterEach, describe, expect, test } from "bun:test"
import { loadWaitlistNotify } from "../../src/config"

const VARS = [
  "WAITLIST_NOTIFY_API_BASE_URL",
  "WAITLIST_NOTIFY_API_KEY",
  "WAITLIST_NOTIFY_WORKSPACE_ID",
  "WAITLIST_NOTIFY_STREAM_ID",
] as const

const COMPLETE = {
  WAITLIST_NOTIFY_API_BASE_URL: "https://app.threa.io",
  WAITLIST_NOTIFY_API_KEY: "bot_key_1",
  WAITLIST_NOTIFY_WORKSPACE_ID: "ws_1",
  WAITLIST_NOTIFY_STREAM_ID: "stream_1",
}

/**
 * The boot guard behind the announcement. A half-set group is a deploy mistake
 * that would otherwise only surface as a swallowed error at the first signup,
 * so it has to fail loudly at boot (INV-11).
 */
describe("loadWaitlistNotify", () => {
  const original = Object.fromEntries(VARS.map((name) => [name, process.env[name]]))

  function setEnv(vars: Partial<Record<(typeof VARS)[number], string>>) {
    for (const name of VARS) {
      const value = vars[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }

  afterEach(() => {
    for (const name of VARS) {
      const value = original[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  test("returns null when none of the group is set", () => {
    setEnv({})
    expect(loadWaitlistNotify()).toBeNull()
  })

  test("returns the target when the whole group is set", () => {
    setEnv(COMPLETE)
    expect(loadWaitlistNotify()).toEqual({
      apiBaseUrl: "https://app.threa.io",
      apiKey: "bot_key_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
    })
  })

  test("throws naming the missing variables when the group is partial", () => {
    setEnv({ ...COMPLETE, WAITLIST_NOTIFY_API_KEY: undefined, WAITLIST_NOTIFY_STREAM_ID: undefined })
    expect(() => loadWaitlistNotify()).toThrow(
      "Waitlist notification is partially configured; missing WAITLIST_NOTIFY_API_KEY, WAITLIST_NOTIFY_STREAM_ID"
    )
  })

  test("throws when the ids are not a workspace and a stream id", () => {
    setEnv({ ...COMPLETE, WAITLIST_NOTIFY_STREAM_ID: "ws_2" })
    expect(() => loadWaitlistNotify()).toThrow("must be a ws_ id")
  })
})
