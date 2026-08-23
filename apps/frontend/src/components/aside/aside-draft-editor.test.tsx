import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import type { JSONContent } from "@threa/types"
import { spyOnExport } from "@/test"
import * as draftComposerModule from "@/hooks/use-draft-composer"
import * as composerModule from "@/components/composer"
import type { DraftComposerState } from "@/hooks/use-draft-composer"
import { AsideDraftEditor } from "./aside-draft-editor"

const EMPTY: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }

function composerStub(overrides: Partial<DraftComposerState> = {}): DraftComposerState {
  return {
    content: EMPTY,
    isLoaded: true,
    pendingAttachments: [],
    getPendingAttachmentsSnapshot: () => [],
    isUploading: false,
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
    // The card's own wiring is the composer's; here it reports what the editor handed it.
    spyOnExport(composerModule, "MessageComposer").mockReturnValue(((props: {
      submitLabel?: string
      onExpandClick?: () => void
      scheduledMessagesTrigger?: unknown
      stashedDrafts?: unknown
      commandStreamId?: string | null
      includeStreamCommands?: boolean
      expanded?: boolean
    }) => (
      <div
        data-testid="message-composer"
        data-submit-label={props.submitLabel}
        data-expand={props.onExpandClick ? "yes" : "no"}
        data-schedule={props.scheduledMessagesTrigger ? "yes" : "no"}
        data-stash={props.stashedDrafts ? "yes" : "no"}
        data-commands={props.includeStreamCommands === false ? "editor-only" : "stream"}
        data-expanded={props.expanded ? "yes" : "no"}
      />
    )) as never)
    const onConsumed = vi.fn()

    render(
      <AsideDraftEditor
        workspaceId="ws_1"
        scope="aside:stream_aside:draft_1"
        onBack={vi.fn()}
        onSendToComposer={vi.fn(async () => null)}
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
    // A real composer card — files, emoji, dictation — with the hand-off as its
    // primary action and none of the stream composer's send-time extras.
    const card = screen.getByTestId("message-composer")
    expect({
      submit: card.getAttribute("data-submit-label"),
      expand: card.getAttribute("data-expand"),
      schedule: card.getAttribute("data-schedule"),
      stash: card.getAttribute("data-stash"),
      commands: card.getAttribute("data-commands"),
      expanded: card.getAttribute("data-expanded"),
    }).toEqual({
      submit: "Send to composer",
      expand: "no",
      schedule: "no",
      stash: "no",
      commands: "editor-only",
      expanded: "yes",
    })
  })

  it("waits for the draft to load before appending, so a block never lands on a stale empty body", () => {
    const composer = composerStub({ isLoaded: false })
    // `spyOnExport` swaps the module getter, so the mocked value IS the hook.
    spyOnExport(draftComposerModule, "useDraftComposer").mockReturnValue((() => composer) as never)
    spyOnExport(composerModule, "MessageComposer").mockReturnValue((() => <div />) as never)

    render(
      <AsideDraftEditor
        workspaceId="ws_1"
        scope="aside:stream_aside:draft_1"
        onBack={vi.fn()}
        onSendToComposer={vi.fn(async () => null)}
        pendingAgentBlocks={[{ authorId: "bot_1", authorName: "Deploybot", content: [] }]}
        onPendingAgentBlocksConsumed={vi.fn()}
      />
    )

    expect(composer.handleContentChange).not.toHaveBeenCalled()
  })
})
