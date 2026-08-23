import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { forwardRef } from "react"
import type { JSONContent } from "@threa/types"
import { spyOnExport } from "@/test"
import * as draftComposerModule from "@/hooks/use-draft-composer"
import * as editorModule from "@/components/editor"
import type { DraftComposerState } from "@/hooks/use-draft-composer"
import { AsideDraftEditor } from "./aside-draft-editor"

const EMPTY: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }

function composerStub(overrides: Partial<DraftComposerState> = {}): DraftComposerState {
  return {
    content: EMPTY,
    isLoaded: true,
    handleContentChange: vi.fn(),
    flushDraft: vi.fn(async () => undefined),
    clearDraft: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as DraftComposerState
}

afterEach(() => vi.restoreAllMocks())

describe("AsideDraftEditor — Insert into draft", () => {
  it("appends queued agent replies to the draft as attributed blocks once it has loaded, then clears the queue", async () => {
    const composer = composerStub({
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "my opening" }] }] },
    })
    // `spyOnExport` swaps the module getter, so the mocked value IS the hook.
    spyOnExport(draftComposerModule, "useDraftComposer").mockReturnValue((() => composer) as never)
    spyOnExport(editorModule, "RichEditor").mockReturnValue(
      forwardRef(() => <div data-testid="rich-editor" />) as never
    )
    const onConsumed = vi.fn()

    render(
      <AsideDraftEditor
        workspaceId="ws_1"
        scope="aside:stream_aside:draft_1"
        onBack={vi.fn()}
        onSendToComposer={vi.fn(async () => true)}
        pendingAgentBlocks={[
          {
            authorId: "persona_01ARIADNE",
            authorName: "Ariadne",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Two options." }] }],
          },
        ]}
        onPendingAgentBlocksConsumed={onConsumed}
      />
    )

    await waitFor(() => expect(composer.handleContentChange).toHaveBeenCalledTimes(1))
    expect(composer.handleContentChange).toHaveBeenCalledWith({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "my opening" }] },
        {
          type: "agentBlock",
          attrs: { authorId: "persona_01ARIADNE", authorName: "Ariadne" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Two options." }] }],
        },
        { type: "paragraph" },
      ],
    })
    expect(onConsumed).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("rich-editor")).toBeInTheDocument()
  })

  it("waits for the draft to load before appending, so a block never lands on a stale empty body", () => {
    const composer = composerStub({ isLoaded: false })
    // `spyOnExport` swaps the module getter, so the mocked value IS the hook.
    spyOnExport(draftComposerModule, "useDraftComposer").mockReturnValue((() => composer) as never)
    spyOnExport(editorModule, "RichEditor").mockReturnValue(forwardRef(() => <div />) as never)

    render(
      <AsideDraftEditor
        workspaceId="ws_1"
        scope="aside:stream_aside:draft_1"
        onBack={vi.fn()}
        onSendToComposer={vi.fn(async () => true)}
        pendingAgentBlocks={[{ authorId: "bot_1", authorName: "Deploybot", content: [] }]}
        onPendingAgentBlocksConsumed={vi.fn()}
      />
    )

    expect(composer.handleContentChange).not.toHaveBeenCalled()
  })
})
