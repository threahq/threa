import { beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@testing-library/react"
import * as hooksModule from "@/hooks"
import { formatDisplayDate, formatFullDateTime, formatRelativeTime, formatTime } from "@/lib/dates"
import { MemoEmbedCardBody, MemoEmbedDate } from "./card-body"
import type { MemoEmbedSource } from "@/hooks/use-memo-embed-source"

const RESOLVED: MemoEmbedSource = {
  status: "resolved",
  title: "Switched theme to light",
  knowledgeType: "decision",
  memoType: "conversation",
  tags: ["settings", "preferences", "dropped"],
  createdAt: "2026-07-01T10:00:00.000Z",
  updatedAt: "2026-07-02T10:00:00.000Z",
}
const PENDING: MemoEmbedSource = { status: "pending" }
const MISSING: MemoEmbedSource = { status: "missing" }

function renderCard(source: MemoEmbedSource) {
  const { container } = render(
    <MemoEmbedCardBody source={source} fallbackTitle="Theme switch" trailing={<MemoEmbedDate source={source} />} />
  )
  const title = container.querySelector("p")
  if (!title) throw new Error("card has no title element")
  const eyebrow = title.previousElementSibling
  if (!eyebrow) throw new Error("card has no eyebrow row above its title")
  return { container, title, eyebrow }
}

describe("MemoEmbedCardBody", () => {
  // The resolved state renders `RelativeTime`, which reads the workspace
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

  // The defect: the card grew when its fetch landed. Every state has to reserve
  // the same boxes. jsdom cannot measure them (see tests/browser for the height
  // assertions) — what it can prove is that no state skips the reservation.
  it.each([
    ["resolved", RESOLVED],
    ["pending", PENDING],
    ["missing", MISSING],
  ] as const)("reserves the eyebrow line and both title lines while %s", (_name, source) => {
    const { title, eyebrow } = renderCard(source)

    expect(eyebrow.className).toContain("h-4")
    expect(title.className).toContain("min-h-[2.375rem]")
    expect(title.className).toContain("line-clamp-2")
  })

  it("renders the date slot in every state, with a time only once resolved", () => {
    const slotOf = (source: MemoEmbedSource) => {
      const { container } = render(<MemoEmbedDate source={source} />)
      return container.firstElementChild
    }

    expect(slotOf(PENDING)?.className).toContain("w-14")
    expect(slotOf(MISSING)?.className).toContain("w-14")
    expect(slotOf(PENDING)?.textContent).toBe("")
    expect(slotOf(MISSING)?.textContent).toBe("")
    expect(slotOf(RESOLVED)?.textContent).not.toBe("")
  })

  // The unavailable notice used to hang below the title as a third line, which
  // made `missing` taller than every other state.
  it("puts the unavailable notice in the eyebrow line, not below the title", () => {
    const { title, eyebrow } = renderCard(MISSING)

    expect(eyebrow.textContent).toContain("Memo no longer available")
    expect(title.textContent).toBe("Theme switch")
    expect(title.nextElementSibling).toBeNull()
  })

  it("shows the reference's own label until the memo resolves, then the memo's", () => {
    expect(renderCard(PENDING).title.textContent).toBe("Theme switch")
    expect(renderCard(RESOLVED).title.textContent).toBe("Switched theme to light")
  })

  it("shows the knowledge type and at most two tags once resolved", () => {
    const { eyebrow } = renderCard(RESOLVED)

    // Lowercased in CSS, so the DOM text keeps the config's own casing.
    expect(eyebrow.textContent).toMatch(/decision/i)
    expect(eyebrow.textContent).toContain("settings")
    expect(eyebrow.textContent).toContain("preferences")
    expect(eyebrow.textContent).not.toContain("dropped")
  })
})
