import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { AgentSessionRepository, type RecentEpisodeSummary } from "../session-repository"
import { EPISODE_SUMMARY_INJECT_COUNT } from "./config"
import { buildEpisodeSummaryPromptBlock, loadEpisodeSummaryPromptBlock } from "./episode-summaries"

function row(
  summary: string,
  createdAt: string,
  completedAt: string | null,
  digestSourceStreamIds: string[] = []
): RecentEpisodeSummary {
  return {
    summary,
    sessionCreatedAt: new Date(createdAt),
    sessionCompletedAt: completedAt ? new Date(completedAt) : null,
    turnDigests: [
      JSON.stringify({ findings: "f", toolsCalled: [], sources: [], sourceStreamIds: digestSourceStreamIds }),
    ],
  }
}

describe("buildEpisodeSummaryPromptBlock", () => {
  it("returns no text and no source streams when there are no summaries", () => {
    expect(buildEpisodeSummaryPromptBlock([], null)).toEqual({ text: null, sourceStreamIds: [] })
  })

  it("renders newest-first rows oldest-first under a Previous sessions header", () => {
    // Repository returns newest session first; the prompt must read oldest-first.
    const block = buildEpisodeSummaryPromptBlock(
      [
        row("Newer: finalized the export format.", "2026-06-11T09:00:00.000Z", "2026-06-11T09:05:00.000Z"),
        row("Older: scoped the CSV export.", "2026-06-10T09:00:00.000Z", "2026-06-10T09:05:00.000Z"),
      ],
      null
    )

    expect(block.text).not.toBeNull()
    const text = block.text as string
    expect(text).toContain("## Previous sessions")
    expect(text.indexOf("Older: scoped the CSV export.")).toBeLessThan(
      text.indexOf("Newer: finalized the export format.")
    )
    // Timestamp uses the completion time when present.
    expect(text).toContain("[2026-06-10T09:05:00.000Z]")
  })

  it("falls back to the created time when a session has no completion time", () => {
    const { text } = buildEpisodeSummaryPromptBlock([row("A summary.", "2026-06-10T09:00:00.000Z", null)], null)
    expect(text).toContain("[2026-06-10T09:00:00.000Z]")
  })

  it("should drop a summary and its source streams when one of its streams left the access set", () => {
    const { text, sourceStreamIds } = buildEpisodeSummaryPromptBlock(
      [
        row("Revoked: read the private channel.", "2026-06-11T09:00:00.000Z", null, ["stream_ok", "stream_revoked"]),
        row("Kept: read two channels.", "2026-06-10T09:00:00.000Z", null, ["stream_ok", "stream_also_ok"]),
        row("Kept: read one channel.", "2026-06-09T09:00:00.000Z", null, ["stream_ok"]),
      ],
      new Set(["stream_ok", "stream_also_ok"])
    )

    expect(text).toContain("Kept: read two channels.")
    expect(text).toContain("Kept: read one channel.")
    expect(text).not.toContain("Revoked")
    expect([...new Set(sourceStreamIds)].sort()).toEqual(["stream_also_ok", "stream_ok"])
  })
})

describe("loadEpisodeSummaryPromptBlock", () => {
  afterEach(() => mock.restore())

  it("should read summaries inside the caller's workspace", async () => {
    const find = spyOn(AgentSessionRepository, "findRecentEpisodeSummariesByStream").mockResolvedValue([])

    await loadEpisodeSummaryPromptBlock({} as never, {
      workspaceId: "ws_1",
      streamId: "stream_1",
      personaId: "persona_1",
      accessibleStreamIds: null,
    })

    expect(find).toHaveBeenCalledWith(expect.anything(), "ws_1", {
      streamId: "stream_1",
      personaId: "persona_1",
      limit: EPISODE_SUMMARY_INJECT_COUNT,
    })
  })
})
