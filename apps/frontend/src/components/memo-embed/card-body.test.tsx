import { beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@testing-library/react"
import type { MemoEmbedSummary } from "@threahq/types"
import * as hooksModule from "@/hooks"
import { formatDisplayDate, formatFullDateTime, formatRelativeTime, formatTime } from "@/lib/dates"
import { MemoEmbedCardBody, MemoEmbedDate } from "./card-body"

const SUMMARY: MemoEmbedSummary = {
  memoId: "memo_01ABC",
  title: "Switched theme to light",
  knowledgeType: "decision",
  memoType: "conversation",
  tags: ["settings", "preferences", "dropped"],
  updatedAt: "2026-07-02T10:00:00.000Z",
}

function renderCard(summary: MemoEmbedSummary | null) {
  const { container } = render(
    <MemoEmbedCardBody summary={summary} fallbackTitle="Theme switch" trailing={<MemoEmbedDate summary={summary} />} />
  )
  const title = container.querySelector("p")
  if (!title) throw new Error("card has no title element")
  return { container, title }
}

describe("MemoEmbedCardBody", () => {
  // The card's date renders `RelativeTime`, which reads the workspace
  // preferences context. Scoped spy, per INV-48.
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(hooksModule, "useFormattedDate").mockReturnValue({
      formatDate: (date: Date) => formatDisplayDate(date),
      formatTime: (date: Date) => formatTime(date),
      formatRelative: (date: Date, now?: Date) => formatRelativeTime(date, now),
      formatFull: (date: Date) => formatFullDateTime(date),
    } as unknown as ReturnType<typeof hooksModule.useFormattedDate>)
  })

  it("renders the memo's own title, type and first two tags when the summary rode the message", () => {
    const { container, title } = renderCard(SUMMARY)

    expect(title.textContent).toBe("Switched theme to light")
    const eyebrow = title.previousElementSibling
    expect(eyebrow?.textContent).toMatch(/decision/i)
    expect(eyebrow?.textContent).toContain("settings")
    expect(eyebrow?.textContent).toContain("preferences")
    expect(eyebrow?.textContent).not.toContain("dropped")
    expect(container.textContent).toMatch(/ago|yesterday|now|\w{3} \d/)
  })

  // The floor: no summary is a legal, final state — a sealed stream, a message
  // written before summaries shipped, or a memo the room can't uniformly read.
  // It renders the reference's label and nothing else, rather than a loader.
  it("renders the reference's label alone when no summary rode the message", () => {
    const { container, title } = renderCard(null)

    expect(title.textContent).toBe("Theme switch")
    expect(title.previousElementSibling).toBeNull()
    expect(container.querySelectorAll("p")).toHaveLength(1)
  })

  it("shows no date without a summary", () => {
    const { container } = render(<MemoEmbedDate summary={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("falls back to a generic label when the reference carried no text either", () => {
    const { container } = render(<MemoEmbedCardBody summary={null} fallbackTitle="" />)
    expect(container.querySelector("p")?.textContent).toBe("Memo")
  })
})
