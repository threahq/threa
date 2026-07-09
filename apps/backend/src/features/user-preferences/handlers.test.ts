import { describe, expect, it } from "bun:test"
import {
  MESSAGE_COLLAPSE_AT_HEIGHT_MAX,
  MESSAGE_COLLAPSE_AT_HEIGHT_MIN,
  MESSAGE_COLLAPSE_TO_HEIGHT_MAX,
  MESSAGE_COLLAPSE_TO_HEIGHT_MIN,
  BOARD_CARD_COLLAPSE_AT_HEIGHT_MAX,
  BOARD_CARD_COLLAPSE_AT_HEIGHT_MIN,
  BOARD_CARD_COLLAPSE_TO_HEIGHT_MAX,
  BOARD_CARD_COLLAPSE_TO_HEIGHT_MIN,
  VOICE_STEERING_WORDS_MAX,
  VOICE_STEERING_WORD_MAX_LENGTH,
  DEFAULT_USER_PREFERENCES,
} from "@threa/types"
import { updatePreferencesSchema } from "./handlers"

describe("updatePreferencesSchema voiceSteeringWords", () => {
  it("accepts a list and trims each entry", () => {
    const parsed = updatePreferencesSchema.parse({ voiceSteeringWords: ["  Langfuse  ", "pgvector"] })
    expect(parsed.voiceSteeringWords).toEqual(["Langfuse", "pgvector"])
  })

  it("rejects a blank/whitespace-only entry", () => {
    expect(updatePreferencesSchema.safeParse({ voiceSteeringWords: ["ok", "   "] }).success).toBe(false)
  })

  it("rejects an entry over the max length", () => {
    const tooLong = "x".repeat(VOICE_STEERING_WORD_MAX_LENGTH + 1)
    expect(updatePreferencesSchema.safeParse({ voiceSteeringWords: [tooLong] }).success).toBe(false)
  })

  it("rejects more than the max number of words", () => {
    const tooMany = Array.from({ length: VOICE_STEERING_WORDS_MAX + 1 }, (_, i) => `t${i}`)
    expect(updatePreferencesSchema.safeParse({ voiceSteeringWords: tooMany }).success).toBe(false)
  })

  it("treats the field as optional", () => {
    expect(updatePreferencesSchema.parse({}).voiceSteeringWords).toBeUndefined()
  })
})

describe("updatePreferencesSchema boardDefaultLens", () => {
  it("accepts a known lens", () => {
    expect(updatePreferencesSchema.parse({ boardDefaultLens: "mine" }).boardDefaultLens).toBe("mine")
  })

  it("rejects an unknown lens", () => {
    expect(updatePreferencesSchema.safeParse({ boardDefaultLens: "everything" }).success).toBe(false)
  })

  it("treats the field as optional", () => {
    expect(updatePreferencesSchema.parse({}).boardDefaultLens).toBeUndefined()
  })
})

describe("updatePreferencesSchema unreadOpenPosition", () => {
  it("accepts both positions", () => {
    expect(updatePreferencesSchema.parse({ unreadOpenPosition: "latest" }).unreadOpenPosition).toBe("latest")
    expect(updatePreferencesSchema.parse({ unreadOpenPosition: "marker" }).unreadOpenPosition).toBe("marker")
  })

  it("rejects an unknown position", () => {
    expect(updatePreferencesSchema.safeParse({ unreadOpenPosition: "top" }).success).toBe(false)
  })

  it("treats the field as optional and defaults to latest", () => {
    expect(updatePreferencesSchema.parse({}).unreadOpenPosition).toBeUndefined()
    expect(DEFAULT_USER_PREFERENCES.unreadOpenPosition).toBe("latest")
  })
})

describe("updatePreferencesSchema board card collapse settings", () => {
  it("accepts valid board card collapse settings", () => {
    const parsed = updatePreferencesSchema.parse({
      boardCardCollapseEnabled: true,
      boardCardCollapseAtHeight: BOARD_CARD_COLLAPSE_AT_HEIGHT_MIN,
      boardCardCollapseToHeight: BOARD_CARD_COLLAPSE_TO_HEIGHT_MIN,
    })

    expect(parsed.boardCardCollapseEnabled).toBe(true)
    expect(parsed.boardCardCollapseAtHeight).toBe(BOARD_CARD_COLLAPSE_AT_HEIGHT_MIN)
    expect(parsed.boardCardCollapseToHeight).toBe(BOARD_CARD_COLLAPSE_TO_HEIGHT_MIN)
  })

  it("rejects board card collapse heights outside the bounds", () => {
    expect(
      updatePreferencesSchema.safeParse({ boardCardCollapseAtHeight: BOARD_CARD_COLLAPSE_AT_HEIGHT_MIN - 1 }).success
    ).toBe(false)
    expect(
      updatePreferencesSchema.safeParse({ boardCardCollapseAtHeight: BOARD_CARD_COLLAPSE_AT_HEIGHT_MAX + 1 }).success
    ).toBe(false)
    expect(
      updatePreferencesSchema.safeParse({ boardCardCollapseToHeight: BOARD_CARD_COLLAPSE_TO_HEIGHT_MIN - 1 }).success
    ).toBe(false)
    expect(
      updatePreferencesSchema.safeParse({ boardCardCollapseToHeight: BOARD_CARD_COLLAPSE_TO_HEIGHT_MAX + 1 }).success
    ).toBe(false)
  })
})

describe("updatePreferencesSchema message collapse settings", () => {
  it("accepts valid message collapse settings", () => {
    const parsed = updatePreferencesSchema.parse({
      messageCollapseEnabled: true,
      messageCollapseAtHeight: MESSAGE_COLLAPSE_AT_HEIGHT_MIN,
      messageCollapseToHeight: MESSAGE_COLLAPSE_TO_HEIGHT_MIN,
    })

    expect(parsed.messageCollapseEnabled).toBe(true)
    expect(parsed.messageCollapseAtHeight).toBe(MESSAGE_COLLAPSE_AT_HEIGHT_MIN)
    expect(parsed.messageCollapseToHeight).toBe(MESSAGE_COLLAPSE_TO_HEIGHT_MIN)
  })

  it("rejects collapse-at heights outside the bounds", () => {
    expect(
      updatePreferencesSchema.safeParse({ messageCollapseAtHeight: MESSAGE_COLLAPSE_AT_HEIGHT_MIN - 1 }).success
    ).toBe(false)
    expect(
      updatePreferencesSchema.safeParse({ messageCollapseAtHeight: MESSAGE_COLLAPSE_AT_HEIGHT_MAX + 1 }).success
    ).toBe(false)
  })

  it("rejects collapse-to heights outside the bounds", () => {
    expect(
      updatePreferencesSchema.safeParse({ messageCollapseToHeight: MESSAGE_COLLAPSE_TO_HEIGHT_MIN - 1 }).success
    ).toBe(false)
    expect(
      updatePreferencesSchema.safeParse({ messageCollapseToHeight: MESSAGE_COLLAPSE_TO_HEIGHT_MAX + 1 }).success
    ).toBe(false)
  })

  it("treats the fields as optional", () => {
    const parsed = updatePreferencesSchema.parse({})
    expect(parsed.messageCollapseEnabled).toBeUndefined()
    expect(parsed.messageCollapseAtHeight).toBeUndefined()
    expect(parsed.messageCollapseToHeight).toBeUndefined()
  })
})
