import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { AgentSessionRepository, type RecentEpisodeSummary } from "../session-repository"
import { EPISODE_SUMMARY_INJECT_COUNT } from "./config"
import { buildEpisodeSummaryPromptBlock, loadEpisodeSummaryPromptBlock } from "./episode-summaries"

function row(
  summary: string,
  createdAt: string,
  completedAt: string | null,
  digestSourceStreamIds: string[] = [],
  digestAudienceBrowses: (boolean | undefined)[] = [undefined]
): RecentEpisodeSummary {
  return {
    summary,
    sessionCreatedAt: new Date(createdAt),
    sessionCompletedAt: completedAt ? new Date(completedAt) : null,
    turnDigests: digestAudienceBrowses.map((audienceBrowses) =>
      JSON.stringify({
        findings: "f",
        toolsCalled: [],
        sources: [],
        sourceStreamIds: digestSourceStreamIds,
        audienceBrowses,
      })
    ),
  }
}

describe("buildEpisodeSummaryPromptBlock", () => {
  it("returns no text and no source streams when there are no summaries", () => {
    expect(buildEpisodeSummaryPromptBlock([], null, true)).toEqual({ text: null, sourceStreamIds: [] })
  })

  it("renders newest-first rows oldest-first under a Previous sessions header", () => {
    // Repository returns newest session first; the prompt must read oldest-first.
    const block = buildEpisodeSummaryPromptBlock(
      [
        row("Newer: finalized the export format.", "2026-06-11T09:00:00.000Z", "2026-06-11T09:05:00.000Z"),
        row("Older: scoped the CSV export.", "2026-06-10T09:00:00.000Z", "2026-06-10T09:05:00.000Z"),
      ],
      null,
      true
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
    const { text } = buildEpisodeSummaryPromptBlock([row("A summary.", "2026-06-10T09:00:00.000Z", null)], null, true)
    expect(text).toContain("[2026-06-10T09:00:00.000Z]")
  })

  it("should drop a summary and its source streams when one of its streams left the access set", () => {
    const { text, sourceStreamIds } = buildEpisodeSummaryPromptBlock(
      [
        row("Revoked: read the private channel.", "2026-06-11T09:00:00.000Z", null, ["stream_ok", "stream_revoked"]),
        row("Kept: read two channels.", "2026-06-10T09:00:00.000Z", null, ["stream_ok", "stream_also_ok"]),
        row("Kept: read one channel.", "2026-06-09T09:00:00.000Z", null, ["stream_ok"]),
      ],
      new Set(["stream_ok", "stream_also_ok"]),
      true
    )

    expect(text).toContain("Kept: read two channels.")
    expect(text).toContain("Kept: read one channel.")
    expect(text).not.toContain("Revoked")
    expect([...new Set(sourceStreamIds)].sort()).toEqual(["stream_also_ok", "stream_ok"])
  })

  it("should carry a summary into a non-browsing turn only when every digest was written for a non-browsing audience", () => {
    const rows = [
      row("Guests only.", "2026-06-12T09:00:00.000Z", null, ["stream_guests"], [false, false]),
      row("Mixed audiences.", "2026-06-11T09:00:00.000Z", null, ["stream_mixed"], [false, true]),
      row("Before the flag.", "2026-06-10T09:00:00.000Z", null, ["stream_legacy"], [undefined]),
      row("No digests.", "2026-06-09T09:00:00.000Z", null, [], []),
    ]
    const accessible = new Set(["stream_guests", "stream_mixed", "stream_legacy"])
    const kept = (browses: boolean) => {
      const { text, sourceStreamIds } = buildEpisodeSummaryPromptBlock(rows, accessible, browses)
      return {
        summaries: ["Guests only.", "Mixed audiences.", "Before the flag.", "No digests."].filter((s) =>
          text?.includes(s)
        ),
        sourceStreamIds: [...new Set(sourceStreamIds)].sort(),
      }
    }

    expect({ browsing: kept(true), notBrowsing: kept(false) }).toEqual({
      browsing: {
        summaries: ["Guests only.", "Mixed audiences.", "Before the flag.", "No digests."],
        sourceStreamIds: ["stream_guests", "stream_legacy", "stream_mixed"],
      },
      notBrowsing: { summaries: ["Guests only.", "No digests."], sourceStreamIds: ["stream_guests"] },
    })
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
      memoAudienceBrowses: true,
    })

    expect(find).toHaveBeenCalledWith(expect.anything(), "ws_1", {
      streamId: "stream_1",
      personaId: "persona_1",
      limit: EPISODE_SUMMARY_INJECT_COUNT,
    })
  })
})
