import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { spyOnExport } from "@/test/spy"
import { ServicesProvider, type StreamService } from "@/contexts"
import * as editorModule from "@/components/editor"
import { serializeToMarkdown } from "@/components/editor/editor-markdown"
import { StreamTypes, Visibilities, type JSONContent, type Stream } from "@threahq/types"
import { DescriptionSection } from "./description-section"

// Capture the controlled editor's props so the test can drive onChange without
// mounting TipTap (and its auth/workspace provider chain).
let lastOnChange: ((json: JSONContent) => void) | null = null
let lastOnSubmit: (() => void) | null = null

type RichEditorMockProps = {
  value: JSONContent
  onChange: (json: JSONContent) => void
  onSubmit: () => void
  disabled?: boolean
}

beforeEach(() => {
  lastOnChange = null
  lastOnSubmit = null
  // RichEditor is a forwardRef export — swap via the
  // getter accessor (vi.spyOn can't replace a non-function export).
  spyOnExport(editorModule, "RichEditor").mockReturnValue(((props: RichEditorMockProps) => {
    lastOnChange = props.onChange
    lastOnSubmit = props.onSubmit
    // Render the seeded value as markdown so seeding is observable.
    return (
      <div data-testid="rich-editor" aria-disabled={props.disabled ?? false}>
        {serializeToMarkdown(props.value)}
      </div>
    )
  }) as unknown as typeof editorModule.RichEditor)
})

afterEach(() => vi.restoreAllMocks())

const EDITED: JSONContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "New blurb" }] }],
}
const STORED = EDITED as Stream["descriptionJson"]

function channel(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "stream_chan",
    workspaceId: "ws_1",
    type: StreamTypes.CHANNEL,
    displayName: null,
    slug: "general",
    description: null,
    visibility: Visibilities.PUBLIC,
    parentStreamId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "usr_1",
    createdAt: "2026-06-22T10:00:00Z",
    updatedAt: "2026-06-22T10:00:00Z",
    archivedAt: null,
    ...overrides,
  }
}

function renderSection(stream: Stream, update = vi.fn().mockResolvedValue({}), locked = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ServicesProvider services={{ streams: { update } as unknown as StreamService }}>
        <DescriptionSection workspaceId="ws_1" stream={stream} locked={locked} />
      </ServicesProvider>
    </QueryClientProvider>
  )
  return { update }
}

describe("DescriptionSection", () => {
  it("seeds the editor from descriptionJson (canonical), not the markdown projection", () => {
    renderSection(
      channel({
        description: "stale markdown",
        descriptionJson: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "From JSON" }] }],
        },
      })
    )
    expect(screen.getByTestId("rich-editor")).toHaveTextContent("From JSON")
  })

  it("falls back to the markdown projection when descriptionJson is absent (legacy rows)", () => {
    renderSection(channel({ description: "Hello **world**" }))
    expect(screen.getByTestId("rich-editor")).toHaveTextContent("Hello **world**")
  })

  it("should disable the editor and offer no Save when the section is locked", () => {
    renderSection(channel({ description: "Existing" }), undefined, true)
    expect({
      editorDisabled: screen.getByTestId("rich-editor").getAttribute("aria-disabled"),
      save: screen.queryByRole("button", { name: "Save" }),
      reset: screen.queryByRole("button", { name: "Reset" }),
    }).toEqual({ editorDisabled: "true", save: null, reset: null })
  })

  it("saves nothing on blur when the description is unchanged", () => {
    const { update } = renderSection(channel({ description: "Existing" }))
    fireEvent.focusOut(screen.getByTestId("rich-editor"))
    expect(update).not.toHaveBeenCalled()
  })

  it("autosaves the edited content as descriptionJson on blur and says Saved in place", async () => {
    const saved = channel({ description: "New blurb", descriptionJson: STORED })
    const { update } = renderSection(channel({ description: "" }), vi.fn().mockResolvedValue(saved))

    act(() => lastOnChange?.(EDITED))
    fireEvent.focusOut(screen.getByTestId("rich-editor"))

    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", "stream_chan", { descriptionJson: STORED }))
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved"))
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
  })

  it("saves on ⌘/Ctrl+Enter without leaving the editor", async () => {
    const { update } = renderSection(channel({ description: "" }))

    act(() => lastOnChange?.(EDITED))
    act(() => lastOnSubmit?.())

    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", "stream_chan", { descriptionJson: STORED }))
  })

  it("reverts the draft on Escape instead of saving it", () => {
    const { update } = renderSection(channel({ description: "Existing" }))

    act(() => lastOnChange?.(EDITED))
    expect(screen.getByTestId("rich-editor")).toHaveTextContent("New blurb")
    fireEvent.keyDown(screen.getByTestId("rich-editor"), { key: "Escape" })
    fireEvent.focusOut(screen.getByTestId("rich-editor"))

    expect(screen.getByTestId("rich-editor")).toHaveTextContent("Existing")
    expect(update).not.toHaveBeenCalled()
  })

  it("keeps a failed draft and says so in place", async () => {
    const update = vi.fn().mockRejectedValue(new Error("offline"))
    renderSection(channel({ description: "" }), update)

    act(() => lastOnChange?.(EDITED))
    fireEvent.focusOut(screen.getByTestId("rich-editor"))

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save the description")
    expect(screen.getByTestId("rich-editor")).toHaveTextContent("New blurb")
  })

  it("preserves an in-progress edit when the stream object updates without a description change", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const update = vi.fn().mockResolvedValue({})
    const wrap = (stream: Stream) => (
      <QueryClientProvider client={queryClient}>
        <ServicesProvider services={{ streams: { update } as unknown as StreamService }}>
          <DescriptionSection workspaceId="ws_1" stream={stream} />
        </ServicesProvider>
      </QueryClientProvider>
    )
    const { rerender } = render(wrap(channel({ description: null, descriptionJson: null })))

    act(() => lastOnChange?.(EDITED))

    // An unrelated stream-cache write lands: a new stream object with a new
    // descriptionJson identity, but the same (empty) description. The editor
    // must NOT reset — re-seeding here would drop the edit.
    rerender(wrap(channel({ description: null, descriptionJson: { type: "doc", content: [{ type: "paragraph" }] } })))

    expect(screen.getByTestId("rich-editor")).toHaveTextContent("New blurb")
    fireEvent.focusOut(screen.getByTestId("rich-editor"))
    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", "stream_chan", { descriptionJson: STORED }))
  })

  it("follows a description saved elsewhere when there is no draft", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrap = (stream: Stream) => (
      <QueryClientProvider client={queryClient}>
        <ServicesProvider services={{ streams: { update: vi.fn() } as unknown as StreamService }}>
          <DescriptionSection workspaceId="ws_1" stream={stream} />
        </ServicesProvider>
      </QueryClientProvider>
    )
    const { rerender } = render(wrap(channel({ description: "Before" })))
    rerender(wrap(channel({ description: "After", descriptionJson: STORED })))
    expect(screen.getByTestId("rich-editor")).toHaveTextContent("New blurb")
  })
})
