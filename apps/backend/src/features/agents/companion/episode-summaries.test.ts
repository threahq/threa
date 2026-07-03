import { describe, expect, it } from "bun:test"
import type { RecentEpisodeSummary } from "../session-repository"
import { buildEpisodeSummaryPromptBlock } from "./episode-summaries"

function row(summary: string, createdAt: string, completedAt: string | null): RecentEpisodeSummary {
  return {
    summary,
    sessionCreatedAt: new Date(createdAt),
    sessionCompletedAt: completedAt ? new Date(completedAt) : null,
  }
}

describe("buildEpisodeSummaryPromptBlock", () => {
  it("returns null when there are no summaries", () => {
    expect(buildEpisodeSummaryPromptBlock([])).toBeNull()
  })

  it("renders newest-first rows oldest-first under a Previous sessions header", () => {
    // Repository returns newest session first; the prompt must read oldest-first.
    const block = buildEpisodeSummaryPromptBlock([
      row("Newer: finalized the export format.", "2026-06-11T09:00:00.000Z", "2026-06-11T09:05:00.000Z"),
      row("Older: scoped the CSV export.", "2026-06-10T09:00:00.000Z", "2026-06-10T09:05:00.000Z"),
    ])

    expect(block).not.toBeNull()
    const text = block as string
    expect(text).toContain("## Previous sessions")
    expect(text.indexOf("Older: scoped the CSV export.")).toBeLessThan(
      text.indexOf("Newer: finalized the export format.")
    )
    // Timestamp uses the completion time when present.
    expect(text).toContain("[2026-06-10T09:05:00.000Z]")
  })

  it("falls back to the created time when a session has no completion time", () => {
    const block = buildEpisodeSummaryPromptBlock([row("A summary.", "2026-06-10T09:00:00.000Z", null)])
    expect(block).toContain("[2026-06-10T09:00:00.000Z]")
  })
})
