import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, userEvent } from "@/test"
import * as preferencesModule from "@/contexts/preferences-context"
import type { AttachmentSearchItem } from "@/api/attachments"
import { takeBlockFocus } from "@/lib/docs/block-focus"
import { ExplorerRow } from "./explorer-row"

function makeItem(overrides: Partial<AttachmentSearchItem> = {}): AttachmentSearchItem {
  return {
    id: "attach_a",
    workspaceId: "ws_1",
    streamId: "str_design",
    messageId: "msg_1",
    uploadedBy: "usr_1",
    filename: "handbook.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024,
    storageProvider: "s3",
    storagePath: "ws_1/attach_a/handbook.pdf",
    processingStatus: "completed",
    safetyStatus: "clean",
    createdAt: new Date("2026-05-01T10:00:00.000Z").toISOString() as unknown as Date,
    extraction: null,
    streamSlug: "design",
    streamName: "Design",
    streamType: "channel",
    uploaderSlug: "mira",
    uploaderName: "Mira",
    referenceCount: 0,
    docBlockId: null,
    ...overrides,
  } as AttachmentSearchItem
}

function renderRow(props: Partial<React.ComponentProps<typeof ExplorerRow>> = {}) {
  const item = props.item ?? makeItem()
  return render(
    <MemoryRouter>
      <ExplorerRow
        workspaceId="ws_1"
        item={item}
        isSelected={false}
        onSelect={props.onSelect ?? (() => undefined)}
        onSelectAttachment={props.onSelectAttachment}
      />
    </MemoryRouter>
  )
}

function mockPreferences() {
  vi.spyOn(preferencesModule, "usePreferences").mockReturnValue({
    preferences: { dateFormat: "YYYY-MM-DD", timeFormat: "24h", timezone: "UTC" } as never,
  } as unknown as ReturnType<typeof preferencesModule.usePreferences>)
}

describe("ExplorerRow onSelectAttachment", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockPreferences()
  })

  it("hands back the whole attachment and skips the URL-state onSelect when set", async () => {
    const onSelect = vi.fn()
    const onSelectAttachment = vi.fn()
    const item = makeItem()
    const user = userEvent.setup()
    renderRow({ item, onSelect, onSelectAttachment })

    await user.click(screen.getByRole("button", { name: /handbook\.pdf/i }))

    expect(onSelectAttachment).toHaveBeenCalledWith(item)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("falls back to the URL-state onSelect(id) when no picker override is given", async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    renderRow({ onSelect })

    await user.click(screen.getByRole("button", { name: /handbook\.pdf/i }))

    expect(onSelect).toHaveBeenCalledWith("attach_a")
  })

  it("hides the open-in-stream link in picker mode so the row is a single pick action", () => {
    renderRow({ onSelectAttachment: vi.fn() })
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
  })
})

describe("ExplorerRow source link", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockPreferences()
  })

  it("links a message's file to its message", () => {
    renderRow()
    expect(screen.getByRole("link", { name: "Open in #design" })).toHaveAttribute(
      "href",
      "/w/ws_1/s/str_design?m=msg_1"
    )
  })

  it("links a doc's file to the doc and lands it on the embedding block", async () => {
    const user = userEvent.setup()
    renderRow({
      item: makeItem({
        streamId: "stream_doc",
        messageId: null,
        docBlockId: "blk_embed",
        streamSlug: null,
        streamName: "Launch plan",
        streamType: "doc",
      }),
    })

    const link = screen.getByRole("link", { name: "Open in Launch plan" })
    expect(link).toHaveAttribute("href", "/w/ws_1/s/stream_doc")
    await user.click(link)

    expect(takeBlockFocus("stream_doc")).toBe("blk_embed")
  })

  it("leaves block focus alone when a modified click opens the doc elsewhere", async () => {
    const user = userEvent.setup()
    renderRow({
      item: makeItem({ streamId: "stream_doc", messageId: null, docBlockId: "blk_embed", streamType: "doc" }),
    })

    await user.keyboard("{Meta>}")
    await user.click(screen.getByRole("link", { name: /Open in/ }))
    await user.keyboard("{/Meta}")

    expect(takeBlockFocus("stream_doc")).toBeNull()
  })
})
