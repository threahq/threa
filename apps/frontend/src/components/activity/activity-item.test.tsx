import { beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import type { Activity } from "@threahq/types"
import * as hooksModule from "@/hooks"
import { formatDisplayDate, formatFullDateTime, formatRelativeTime, formatTime } from "@/lib/dates"
import { render, screen } from "@/test"
import { ActivityItem } from "./activity-item"

const docMention: Activity = {
  id: "activity_1",
  workspaceId: "ws_1",
  userId: "usr_peer",
  activityType: "doc_mention",
  streamId: "stream_doc",
  messageId: "blk_1",
  actorId: "usr_alice",
  actorType: "user",
  context: { contentPreview: "Ping [@peer](user:usr_peer) about **rotation**", streamName: "Rotation plan" },
  readAt: null,
  createdAt: "2026-10-28T10:00:00.000Z",
  isSelf: false,
  emoji: null,
}

describe("ActivityItem", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(hooksModule, "useFormattedDate").mockReturnValue({
      formatDate: (date: Date) => formatDisplayDate(date),
      formatTime: (date: Date) => formatTime(date),
      formatRelative: (date: Date, now?: Date) => formatRelativeTime(date, now),
      formatFull: (date: Date) => formatFullDateTime(date),
    } as unknown as ReturnType<typeof hooksModule.useFormattedDate>)
  })

  it("should name the doc, strip the block preview, and link to the doc landing on the block for a doc mention", () => {
    render(
      <MemoryRouter>
        <ActivityItem
          activity={docMention}
          actorName="Alice"
          actorAvatar={{ fallback: "A" }}
          streamName="Rotation plan"
          workspaceId="ws_1"
          onMarkAsRead={() => {}}
        />
      </MemoryRouter>
    )

    const link = screen.getByRole("link")
    expect({
      href: link.getAttribute("href"),
      caption: screen.getByText("mentioned you in", { exact: false }).textContent,
      preview: screen.getByText(/Ping/).textContent,
    }).toEqual({
      href: "/w/ws_1/s/stream_doc?m=blk_1",
      caption: "Alice mentioned you in Rotation plan",
      preview: "Ping @peer about rotation",
    })
  })
})
