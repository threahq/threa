import { describe, expect, it } from "bun:test"
import type { Draft } from "../drafts"
import { ASIDE_DRAFT_CONTEXT_MAX_CHARS, renderAsideDraftSection } from "./aside-drafts-context"

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
    updatedAt: new Date("2026-08-24T07:05:00.000Z"),
    deletedAt: null,
    ...overrides,
  } as Draft
}

describe("renderAsideDraftSection", () => {
  it("renders each draft's body with when it was last edited", () => {
    const section = renderAsideDraftSection([
      draft({ contentMarkdown: "The rollout can wait until Tuesday." }),
      draft({ id: "draft_2", contentMarkdown: "Second thought", attachmentIds: ["attach_1"] }),
    ])

    expect(section).toContain("## Drafts open in this aside")
    expect(section).toContain("### Draft (last edited 2026-08-24T07:05:00.000Z)")
    expect(section).toContain("The rollout can wait until Tuesday.")
    expect(section).toContain("### Draft (last edited 2026-08-24T07:05:00.000Z · 1 attachment)")
    expect(section).toContain("Second thought")
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

  it("names encrypted drafts it cannot read instead of reporting an empty dock (INV-11)", () => {
    const section = renderAsideDraftSection([
      draft({ contentMarkdown: null, ciphertext: "sealed", e2eVersion: 1 }),
      draft({ id: "draft_2", contentMarkdown: null, ciphertext: "sealed", e2eVersion: 1 }),
    ])

    expect(section).toContain("2 more drafts are end-to-end encrypted")
  })
})
