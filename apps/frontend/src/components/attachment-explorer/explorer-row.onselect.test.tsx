import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, userEvent } from "@/test"
import * as preferencesModule from "@/contexts/preferences-context"
import type { AttachmentSearchItem } from "@/api/attachments"
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

describe("ExplorerRow onSelectAttachment", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(preferencesModule, "usePreferences").mockReturnValue({
      preferences: { dateFormat: "YYYY-MM-DD", timeFormat: "24h", timezone: "UTC" } as never,
    } as unknown as ReturnType<typeof preferencesModule.usePreferences>)
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
