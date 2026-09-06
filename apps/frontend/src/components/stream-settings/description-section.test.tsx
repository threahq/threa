import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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

type RichEditorMockProps = { value: JSONContent; onChange: (json: JSONContent) => void }
type ActionBarMockProps = { trailingContent?: ReactNode }

beforeEach(() => {
  lastOnChange = null
  // RichEditor / EditorActionBar are forwardRef/const exports — swap via the
  // getter accessor (vi.spyOn can't replace a non-function export).
  spyOnExport(editorModule, "RichEditor").mockReturnValue(((props: RichEditorMockProps) => {
    lastOnChange = props.onChange
    // Render the seeded value as markdown so seeding is observable.
    return <div data-testid="rich-editor">{serializeToMarkdown(props.value)}</div>
  }) as unknown as typeof editorModule.RichEditor)
  spyOnExport(editorModule, "EditorActionBar").mockReturnValue(((props: ActionBarMockProps) => (
    <div data-testid="action-bar">{props.trailingContent}</div>
  )) as unknown as typeof editorModule.EditorActionBar)
})

afterEach(() => vi.restoreAllMocks())

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

function renderSection(stream: Stream, update = vi.fn().mockResolvedValue({})) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ServicesProvider services={{ streams: { update } as unknown as StreamService }}>
        <DescriptionSection workspaceId="ws_1" stream={stream} />
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

  it("keeps Save disabled until the description changes", () => {
    renderSection(channel({ description: "Existing" }))
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })

  it("saves the edited content as descriptionJson (not markdown)", async () => {
    const { update } = renderSection(channel({ description: "" }))

    const edited: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "New blurb" }] }],
    }
    act(() => lastOnChange?.(edited))

    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", "stream_chan", { descriptionJson: edited }))
  })

  it("preserves an in-progress edit when the stream object updates without a description change", () => {
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

    const edited: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "draft" }] }],
    }
    act(() => lastOnChange?.(edited))
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()

    // An unrelated stream-cache write lands: a new stream object with a new
    // descriptionJson identity, but the saved description (markdown) is
    // unchanged. The editor must NOT reset — re-seeding here would drop the edit.
    rerender(wrap(channel({ description: null, descriptionJson: { type: "doc", content: [{ type: "paragraph" }] } })))

    expect(screen.getByTestId("rich-editor")).toHaveTextContent("draft")
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
  })
})
