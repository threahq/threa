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
  BOARD_FULL_TAIL_COUNT_MIN,
  BOARD_FULL_TAIL_COUNT_MAX,
  DEFAULT_BOARD_FULL_TAIL_COUNT,
  BOARD_LEDGER_ROWS_MIN,
  BOARD_LEDGER_ROWS_MAX,
  DEFAULT_BOARD_LEDGER_ROWS,
  BOARD_LEAD_LINE_LENGTH_MIN,
  BOARD_LEAD_LINE_LENGTH_MAX,
  DEFAULT_BOARD_LEAD_LINE_LENGTH,
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

  it("degrades a retired or unknown lens to the default instead of rejecting the PATCH", () => {
    expect(updatePreferencesSchema.parse({ boardDefaultLens: "decisions" }).boardDefaultLens).toBe("all")
    expect(updatePreferencesSchema.parse({ boardDefaultLens: "everything" }).boardDefaultLens).toBe("all")
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

describe("updatePreferencesSchema boardDefaultViewId", () => {
  it("accepts a view id", () => {
    expect(updatePreferencesSchema.parse({ boardDefaultViewId: "bview_1" }).boardDefaultViewId).toBe("bview_1")
  })

  it("accepts null to clear the default view", () => {
    expect(updatePreferencesSchema.parse({ boardDefaultViewId: null }).boardDefaultViewId).toBeNull()
  })

  it("rejects an over-long id", () => {
    expect(updatePreferencesSchema.safeParse({ boardDefaultViewId: "x".repeat(65) }).success).toBe(false)
  })

  it("rejects an empty id", () => {
    expect(updatePreferencesSchema.safeParse({ boardDefaultViewId: "" }).success).toBe(false)
  })
})

describe("updatePreferencesSchema defaultCompanionPersonaId", () => {
  it("accepts a persona id", () => {
    expect(updatePreferencesSchema.parse({ defaultCompanionPersonaId: "persona_1" }).defaultCompanionPersonaId).toBe(
      "persona_1"
    )
  })

  it("accepts null to inherit the workspace default", () => {
    expect(updatePreferencesSchema.parse({ defaultCompanionPersonaId: null }).defaultCompanionPersonaId).toBeNull()
  })

  it("rejects an empty id", () => {
    expect(updatePreferencesSchema.safeParse({ defaultCompanionPersonaId: "" }).success).toBe(false)
  })

  it("rejects an over-long id", () => {
    expect(updatePreferencesSchema.safeParse({ defaultCompanionPersonaId: "x".repeat(65) }).success).toBe(false)
  })

  it("treats the field as optional", () => {
    expect(updatePreferencesSchema.parse({}).defaultCompanionPersonaId).toBeUndefined()
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

describe("updatePreferencesSchema board ledger settings", () => {
  it("accepts the ledger settings at their bounds", () => {
    const parsed = updatePreferencesSchema.parse({
      boardFullTailCount: BOARD_FULL_TAIL_COUNT_MIN,
      boardLedgerRows: BOARD_LEDGER_ROWS_MAX,
      boardLeadLineLength: BOARD_LEAD_LINE_LENGTH_MIN,
      boardMassBadge: "off",
    })

    expect(parsed).toEqual({
      boardFullTailCount: BOARD_FULL_TAIL_COUNT_MIN,
      boardLedgerRows: BOARD_LEDGER_ROWS_MAX,
      boardLeadLineLength: BOARD_LEAD_LINE_LENGTH_MIN,
      boardMassBadge: "off",
    })
  })

  it("rejects numbers outside the bounds", () => {
    expect(updatePreferencesSchema.safeParse({ boardFullTailCount: BOARD_FULL_TAIL_COUNT_MIN - 1 }).success).toBe(false)
    expect(updatePreferencesSchema.safeParse({ boardFullTailCount: BOARD_FULL_TAIL_COUNT_MAX + 1 }).success).toBe(false)
    expect(updatePreferencesSchema.safeParse({ boardLedgerRows: BOARD_LEDGER_ROWS_MIN - 1 }).success).toBe(false)
    expect(updatePreferencesSchema.safeParse({ boardLedgerRows: BOARD_LEDGER_ROWS_MAX + 1 }).success).toBe(false)
    expect(updatePreferencesSchema.safeParse({ boardLeadLineLength: BOARD_LEAD_LINE_LENGTH_MIN - 1 }).success).toBe(
      false
    )
    expect(updatePreferencesSchema.safeParse({ boardLeadLineLength: BOARD_LEAD_LINE_LENGTH_MAX + 1 }).success).toBe(
      false
    )
  })

  it("rejects a non-integer row count", () => {
    expect(updatePreferencesSchema.safeParse({ boardLedgerRows: 15.5 }).success).toBe(false)
  })

  it("rejects an unknown mass badge mode", () => {
    expect(updatePreferencesSchema.safeParse({ boardMassBadge: "minutes" }).success).toBe(false)
    // The retired reading-time mode is no longer accepted on the wire; a row
    // still holding it normalizes on read (`normalizeBoardMassBadge`).
    expect(updatePreferencesSchema.safeParse({ boardMassBadge: "count-minutes" }).success).toBe(false)
  })

  it("treats the fields as optional and defaults them", () => {
    expect(updatePreferencesSchema.parse({})).toEqual({})
    expect(DEFAULT_USER_PREFERENCES.boardFullTailCount).toBe(DEFAULT_BOARD_FULL_TAIL_COUNT)
    expect(DEFAULT_USER_PREFERENCES.boardLedgerRows).toBe(DEFAULT_BOARD_LEDGER_ROWS)
    expect(DEFAULT_USER_PREFERENCES.boardLeadLineLength).toBe(DEFAULT_BOARD_LEAD_LINE_LENGTH)
    expect(DEFAULT_USER_PREFERENCES.boardMassBadge).toBe("count")
  })
})

describe("updatePreferencesSchema mobileInlineAttachments", () => {
  it("accepts booleans and rejects other values", () => {
    expect(updatePreferencesSchema.parse({ mobileInlineAttachments: true })).toEqual({
      mobileInlineAttachments: true,
    })
    expect(updatePreferencesSchema.parse({ mobileInlineAttachments: false })).toEqual({
      mobileInlineAttachments: false,
    })
    expect(updatePreferencesSchema.safeParse({ mobileInlineAttachments: "yes" }).success).toBe(false)
  })
})

describe("updatePreferencesSchema accessibility.composerActionSide", () => {
  it("accepts both sides", () => {
    expect(updatePreferencesSchema.parse({ accessibility: { composerActionSide: "left" } }).accessibility).toEqual({
      composerActionSide: "left",
    })
    expect(updatePreferencesSchema.parse({ accessibility: { composerActionSide: "right" } }).accessibility).toEqual({
      composerActionSide: "right",
    })
  })

  it("rejects an unknown side", () => {
    expect(updatePreferencesSchema.safeParse({ accessibility: { composerActionSide: "top" } }).success).toBe(false)
  })

  it("is omitted when not supplied, so a partial accessibility update leaves it alone", () => {
    expect(updatePreferencesSchema.parse({ accessibility: { reducedMotion: true } }).accessibility).toEqual({
      reducedMotion: true,
    })
  })
})
