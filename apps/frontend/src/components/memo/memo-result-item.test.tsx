import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it } from "vitest"
import { render, screen, spyOnExport } from "@/test"
import { createMockMemoResult } from "@/test/fixtures/search"
import * as relativeTimeModule from "@/components/relative-time"
import { MemoResultItem } from "./memo-result-item"

function renderItem(memo: Parameters<typeof createMockMemoResult>[0]) {
  return render(
    <MemoryRouter>
      <MemoResultItem result={createMockMemoResult(memo)} isActive={false} href="/w/ws_1/memory?memo=memo_1" />
    </MemoryRouter>
  )
}

describe("MemoResultItem time", () => {
  beforeEach(() => {
    spyOnExport(relativeTimeModule, "RelativeTime").mockReturnValue((({ date }: { date: string }) => (
      <span data-testid="memo-time">{date}</span>
    )) as unknown as typeof relativeTimeModule.RelativeTime)
  })

  it("shows when the newest source was posted, not when the memo was revised", () => {
    renderItem({
      latestSourceAt: "2026-03-12T12:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    })
    expect(screen.getByTestId("memo-time")).toHaveTextContent("2026-03-12T12:00:00.000Z")
  })

  it("shows no time when no source resolves", () => {
    renderItem({ latestSourceAt: null })
    expect(screen.queryByTestId("memo-time")).not.toBeInTheDocument()
  })
})
