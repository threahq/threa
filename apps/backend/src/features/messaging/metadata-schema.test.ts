import { describe, expect, test } from "bun:test"
import {
  messageMetadataSchema,
  messageMetadataFilterSchema,
  MESSAGE_METADATA_MAX_KEYS,
  MESSAGE_METADATA_MAX_KEY_LENGTH,
  MESSAGE_METADATA_MAX_VALUE_LENGTH,
  MESSAGE_METADATA_RESERVED_PREFIX,
  MESSAGE_METADATA_AGENT_BLOCK_AUTHORS_KEY,
  withDerivedMessageMetadata,
} from "./metadata-schema"

describe("messageMetadataSchema (create)", () => {
  test("accepts a typical external reference map", () => {
    const result = messageMetadataSchema.safeParse({
      "github.pr.id": "42",
      "github.event": "review_requested",
      source: "github",
    })
    expect(result.success).toBe(true)
  })

  test("accepts empty object (caller may choose to attach nothing)", () => {
    expect(messageMetadataSchema.safeParse({}).success).toBe(true)
  })

  test("rejects keys under the reserved threa.* prefix", () => {
    const result = messageMetadataSchema.safeParse({ [`${MESSAGE_METADATA_RESERVED_PREFIX}source`]: "github" })
    expect(result.success).toBe(false)
  })

  test("rejects keys with disallowed characters", () => {
    const result = messageMetadataSchema.safeParse({ "has space": "v" })
    expect(result.success).toBe(false)
  })

  test("rejects empty keys", () => {
    const result = messageMetadataSchema.safeParse({ "": "v" })
    expect(result.success).toBe(false)
  })

  test("rejects keys longer than the max length", () => {
    const longKey = "k".repeat(MESSAGE_METADATA_MAX_KEY_LENGTH + 1)
    const result = messageMetadataSchema.safeParse({ [longKey]: "v" })
    expect(result.success).toBe(false)
  })

  test("rejects values longer than the max length", () => {
    const longVal = "v".repeat(MESSAGE_METADATA_MAX_VALUE_LENGTH + 1)
    const result = messageMetadataSchema.safeParse({ k: longVal })
    expect(result.success).toBe(false)
  })

  test("rejects maps with too many keys", () => {
    const tooMany: Record<string, string> = {}
    for (let i = 0; i <= MESSAGE_METADATA_MAX_KEYS; i++) tooMany[`k${i}`] = "v"
    const result = messageMetadataSchema.safeParse(tooMany)
    expect(result.success).toBe(false)
  })
})

describe("messageMetadataFilterSchema (query)", () => {
  test("accepts a non-empty filter with multiple keys", () => {
    const result = messageMetadataFilterSchema.safeParse({
      "github.pr.id": "42",
      "github.event": "review_requested",
    })
    expect(result.success).toBe(true)
  })

  test("rejects empty filter (would match every message with metadata)", () => {
    const result = messageMetadataFilterSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  test("allows reserved threa.* keys on the query side (lookup of system metadata)", () => {
    const result = messageMetadataFilterSchema.safeParse({
      [`${MESSAGE_METADATA_RESERVED_PREFIX}source`]: "github",
    })
    expect(result.success).toBe(true)
  })
})

describe("withDerivedMessageMetadata", () => {
  test("marks the agents a message carries, alongside caller metadata", () => {
    expect(withDerivedMessageMetadata({ source: "github" }, ["persona_1", "bot_2"])).toEqual({
      source: "github",
      [MESSAGE_METADATA_AGENT_BLOCK_AUTHORS_KEY]: "persona_1,bot_2",
    })
  })

  test("leaves a message with no agent block exactly as the caller sent it", () => {
    expect(withDerivedMessageMetadata({ source: "github" }, [])).toEqual({ source: "github" })
    expect(withDerivedMessageMetadata(undefined, [])).toBeUndefined()
  })

  test("drops whole ids rather than truncating one into a different actor", () => {
    const long = Array.from({ length: 12 }, (_, i) => `persona_${String(i).padStart(30, "0")}`)
    const value = withDerivedMessageMetadata(undefined, long)?.[MESSAGE_METADATA_AGENT_BLOCK_AUTHORS_KEY] ?? ""
    expect(value.length).toBeLessThanOrEqual(MESSAGE_METADATA_MAX_VALUE_LENGTH)
    expect(value.split(",").every((id) => long.includes(id))).toBe(true)
  })
})
