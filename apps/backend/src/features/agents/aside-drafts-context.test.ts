import { describe, expect, it } from "bun:test"
import type { Draft } from "../drafts"
import {
  ASIDE_DRAFT_CONTEXT_MAX_CHARS,
  ASIDE_DRAFT_CONTEXT_TOTAL_CHARS,
  renderAsideDraftSection,
} from "./aside-drafts-context"

function draft(overrides?: Partial<Draft>): Draft {
  return {
    id: "draft_1",
    workspaceId: "ws_1",
    userId: "usr_1",
    scope: "aside:stream_aside:draft_1",
    rootStreamId: null,
    contentJson: null,
    contentMarkdown: "The rollout can wait until Tuesday.",
    attachmentIds: [],
    command: null,
    contextRefs: null,
    ciphertext: null,
    envelope: null,
    e2eVersion: null,
    version: 1,
    lastClientWriteId: null,
    supersededWriteIds: null,
    clientUpdatedAt: new Date("2026-08-24T07:05:00.000Z"),
    stashedAt: null,
    createdAt: new Date("2026-08-24T07:00:00.000Z"),
    updatedAt: new Date("2026-08-24T07:06:00.000Z"),
    deletedAt: null,
    ...overrides,
  } as Draft
}

describe("renderAsideDraftSection", () => {
  it("renders each draft's body between markers, with when the server last saved it", () => {
    const section = renderAsideDraftSection([
      draft({ contentMarkdown: "The rollout can wait until Tuesday." }),
      draft({ id: "draft_2", contentMarkdown: "Second thought", attachmentIds: ["attach_1"] }),
    ])

    expect(section).toContain("## Drafts open in this aside")
    // The SERVER's clock, not the authoring device's: a skewed client would
    // otherwise tell the model how fresh the text is, and be believed.
    expect(section).toContain("### Draft (last saved 2026-08-24T07:06:00.000Z)")
    expect(section).toContain("--- BEGIN DRAFT ---\nThe rollout can wait until Tuesday.\n--- END DRAFT ---")
    expect(section).toContain("### Draft (last saved 2026-08-24T07:06:00.000Z · 1 attachment)")
    expect(section).toContain("Second thought")
  })

  it("renders the save time in the user's own clock and format when the turn carries one", () => {
    const section = renderAsideDraftSection([draft()], {
      currentTime: "2026-08-24T07:10:00.000Z",
      timezone: "Europe/Stockholm",
      utcOffset: "UTC+2",
      dateFormat: "DD/MM/YYYY",
      timeFormat: "24h",
    })

    expect(section).toContain("### Draft (last saved 24/08/2026 09:06)")
  })

  it("bounds the whole section, naming the drafts that did not fit", () => {
    const long = ASIDE_DRAFT_CONTEXT_MAX_CHARS
    const section = renderAsideDraftSection([
      draft({ id: "draft_1", contentMarkdown: "a".repeat(long) }),
      draft({ id: "draft_2", contentMarkdown: "b".repeat(long) }),
      draft({ id: "draft_3", contentMarkdown: "c".repeat(long) }),
    ])

    expect(section!.length).toBeLessThan(ASIDE_DRAFT_CONTEXT_TOTAL_CHARS + 2_000)
    expect(section).toContain("1 older draft in this aside did not fit")
    expect(section).not.toContain("ccc")
  })

  it("says nothing when the dock holds only empty drafts", () => {
    // "New draft" mints a scope before a word is typed; an empty one in the
    // prompt reads as the user having written something blank.
    expect(renderAsideDraftSection([])).toBeNull()
    expect(renderAsideDraftSection([draft({ contentMarkdown: "" }), draft({ contentMarkdown: "   \n" })])).toBeNull()
  })

  it("states the cut when a draft runs past the budget, rather than passing off the head as the whole", () => {
    const section = renderAsideDraftSection([
      draft({ contentMarkdown: "x".repeat(ASIDE_DRAFT_CONTEXT_MAX_CHARS + 50) }),
    ])

    expect(section).toContain(`cut off here at ${ASIDE_DRAFT_CONTEXT_MAX_CHARS} characters`)
    expect(section).not.toContain("x".repeat(ASIDE_DRAFT_CONTEXT_MAX_CHARS + 1))
  })
})
