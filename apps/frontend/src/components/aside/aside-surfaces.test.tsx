import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { StreamTypes } from "@threahq/types"
import { spyOnExport } from "@/test"
import { createMockStream } from "@/test/fixtures"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as pointerModule from "@/hooks/use-pointer"
import * as mobileModule from "@/hooks/use-mobile"
import * as timelineModule from "@/components/timeline"
import * as boundaryModule from "@/components/stream-error-boundary"
import * as panelHostModule from "@/components/layout/panel-host"
import * as contextsModule from "@/contexts"
import { PanelProvider, usePanel } from "@/contexts"
import { useAgentBlock } from "@/components/timeline/agent-block-context"
import * as draftEditorModule from "./aside-draft-editor"
import { clearCallState } from "@/stores/call-store"
import { __resetCallPrefsForTests } from "@/stores/call-prefs-store"
import {
  ASIDE_DRAFT_DEFAULT_HEIGHT,
  getAsideSheetDetent,
  getAsideState,
  openAside,
  resetAsideStoreCache,
  useAsideForHost,
} from "@/stores/aside-store"
import { AsideMobileSheet, useAsideHost, useAsideIsSheet } from "./index"
import { AsidePanel } from "./aside-panel"

const HOST_PATH = "/w/ws_1/board"
const ASIDE = "stream_aside_1"
const aside = createMockStream({
  id: ASIDE,
  type: StreamTypes.ASIDE,
  displayName: "churn number sanity-check",
  parentStreamId: "stream_host",
  parentAnchorId: "msg_anchor_1",
})

/** The aside the way a page's panes lay it out: a pane beside its stream, or a sheet where there is no room for one. */
function Page() {
  const hostKey = useAsideHost()
  return (
    <PanelProvider>
      <AsideSurface hostKey={hostKey} />
    </PanelProvider>
  )
}

function AsideSurface({ hostKey }: { hostKey: string }) {
  const current = useAsideForHost(hostKey)
  const isSheet = useAsideIsSheet()
  if (!current) return null
  return isSheet ? (
    <AsideMobileSheet
      workspaceId="ws_1"
      asideId={current.asideId}
      hostStreamId={current.hostStreamId}
      originScope={current.originScope}
    />
  ) : (
    <AsidePanel workspaceId="ws_1" hostStreamId={current.hostStreamId} />
  )
}

function routes(path = HOST_PATH) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/w/:workspaceId/s/:streamId" element={<Page />} />
        <Route path="/w/:workspaceId/board" element={<Page />} />
      </Routes>
    </MemoryRouter>
  )
}

function renderPage(path = HOST_PATH) {
  return render(routes(path))
}

function openOnHost() {
  openAside({
    hostKey: HOST_PATH,
    hostStreamId: "stream_host",
    asideId: ASIDE,
    originScope: "stream:stream_host",
  })
}

beforeEach(() => {
  resetAsideStoreCache()
  clearCallState()
  __resetCallPrefsForTests()
  localStorage.clear()
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([aside] as never)
  vi.spyOn(mobileModule, "useIsSplitCapable").mockReturnValue(true)
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: null,
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  vi.spyOn(contextsModule, "useSidebar").mockReturnValue({ isMobile: false } as ReturnType<
    typeof contextsModule.useSidebar
  >)
  // The chat pane is the real companion timeline; its data plumbing is out of
  // scope here, so the barrel export renders a marker carrying the stream it
  // was mounted against.
  spyOnExport(timelineModule, "StreamContent").mockReturnValue(((props: { streamId: string; autoFocus?: boolean }) => (
    <div
      data-testid="stream-content"
      data-stream-id={props.streamId}
      data-auto-focus={props.autoFocus ? "true" : undefined}
    />
  )) as never)
  spyOnExport(boundaryModule, "StreamErrorBoundary").mockReturnValue(((props: { children: React.ReactNode }) => (
    <>{props.children}</>
  )) as never)
  // The thread panel is the page's own, mounted wholesale; here it is a marker
  // that can be closed.
  spyOnExport(panelHostModule, "PanelHost").mockReturnValue((() => (
    <button data-testid="panel-host" onClick={usePanel().closePanel}>
      Close thread
    </button>
  )) as never)
})

afterEach(() => vi.restoreAllMocks())

describe("aside surfaces", () => {
  it("should carry an agent reply into an aside draft, never the chat composer", async () => {
    // The companion timeline's "Insert into draft" action, reduced to the one
    // call it makes on the provider the pane mounts around it.
    spyOnExport(timelineModule, "StreamContent").mockReturnValue(((props: { streamId: string }) => {
      const agentBlock = useAgentBlock()
      // The host pane mounts one of these too; only the aside's sits inside the
      // provider, and only it offers the action.
      if (props.streamId !== ASIDE) return <div data-testid="stream-content" />
      return (
        <button
          type="button"
          onClick={() =>
            agentBlock?.insertAgentBlock({
              authorId: "persona_01ARIADNE",
              authorName: "Ariadne",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Two options." }] }],
            })
          }
        >
          insert into draft
        </button>
      )
    }) as never)
    // The editor's own append is covered in aside-draft-editor.test.tsx; here
    // it reports what the pane handed it.
    spyOnExport(draftEditorModule, "AsideDraftEditor").mockReturnValue(((props: {
      scope: string
      pendingAgentBlocks?: { authorId: string }[]
    }) => (
      <div
        data-testid="aside-draft-editor"
        data-draft-scope={props.scope}
        data-pending={props.pendingAgentBlocks?.map((block) => block.authorId).join(",")}
      />
    )) as never)
    renderPage()
    openOnHost()

    fireEvent.click(await screen.findByRole("button", { name: "insert into draft" }))

    const editor = await screen.findByTestId("aside-draft-editor")
    expect(editor.getAttribute("data-draft-scope")).toMatch(/^aside:stream_aside_1:draft_/)
    expect(editor).toHaveAttribute("data-pending", "persona_01ARIADNE")
    // The conversation stays on screen beside the draft — a draft is written
    // FROM what was just said — and the block went nowhere but the draft.
    expect(screen.getByRole("button", { name: "insert into draft" })).toBeInTheDocument()
    expect(screen.getByTestId("aside-drafts")).toHaveAttribute("data-open", "true")
  })

  it("folds the drafts to their count, and unfolds to the tray on the chevron", async () => {
    spyOnExport(draftEditorModule, "AsideDraftEditor").mockReturnValue((() => <div />) as never)
    renderPage()
    openOnHost()

    // Resting state is the count, the way the composer's attachment tray rests.
    const fold = await screen.findByRole("button", { name: /drafts?$/i })
    expect(fold).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByRole("button", { name: "Start a draft" })).toBeNull()

    fireEvent.click(fold)
    expect(fold).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByRole("button", { name: "Start a draft" })).toBeInTheDocument()
  })

  it("divides the aside between the draft and the conversation on a drag, keyboard included", async () => {
    spyOnExport(draftEditorModule, "AsideDraftEditor").mockReturnValue((() => <div />) as never)
    renderPage()
    openOnHost()

    fireEvent.click(await screen.findByRole("button", { name: /drafts?$/i }))
    fireEvent.click(screen.getByRole("button", { name: "Start a draft" }))

    const drafts = await screen.findByTestId("aside-drafts")
    expect(drafts).toHaveStyle({ height: `${ASIDE_DRAFT_DEFAULT_HEIGHT}px` })

    const divider = screen.getByRole("separator", { name: "Resize draft" })
    divider.setPointerCapture = vi.fn()
    divider.releasePointerCapture = vi.fn()
    fireEvent.pointerDown(divider, { pointerId: 1, clientY: 400, isPrimary: true, button: 0 })
    fireEvent.pointerMove(divider, { pointerId: 1, clientY: 460 })
    fireEvent.pointerUp(divider, { pointerId: 1, clientY: 460 })
    await waitFor(() =>
      expect(screen.getByTestId("aside-drafts")).toHaveStyle({ height: `${ASIDE_DRAFT_DEFAULT_HEIGHT + 60}px` })
    )

    fireEvent.keyDown(divider, { key: "ArrowUp", shiftKey: true })
    await waitFor(() => expect(screen.getByTestId("aside-drafts")).toHaveStyle({ height: "316px" }))
  })

  it("should render no aside chrome while nothing is open on this page", () => {
    renderPage()
    expect(screen.queryByTestId("aside-panel")).toBeNull()
  })

  it("names the aside as private and points back at the message it was opened from", async () => {
    renderPage()
    openOnHost()

    expect(await screen.findByText("Private")).toBeInTheDocument()
    // Anchored to a message that isn't in this test's timeline cache: it names
    // the host stream rather than inventing an author, and the sentence itself
    // is the jump — there is no separate "scroll to it" to hunt for. Off the
    // host's own page, it goes there.
    const jump = screen.getByTestId("aside-anchor-line")
    expect(jump).toHaveAttribute("href", "/w/ws_1/s/stream_host?m=msg_anchor_1")
    expect(jump).toHaveTextContent(/^Anchored in/)
  })

  it("should drop the aside when its host page goes away", async () => {
    const view = renderPage()
    openOnHost()
    await screen.findByTestId("aside-panel")

    view.unmount()
    expect(getAsideState()).toBeNull()
  })

  it("should not show another page's aside", () => {
    openOnHost()
    renderPage("/w/ws_1/s/stream_host")
    expect(screen.queryByTestId("aside-panel")).toBeNull()
  })

  it("opens as a sheet in a window too narrow to split, whatever the pointer", () => {
    vi.spyOn(mobileModule, "useIsSplitCapable").mockReturnValue(false)
    openOnHost()
    renderPage()

    expect(screen.getByTestId("aside-sheet")).toBeInTheDocument()
    expect(screen.queryByTestId("aside-panel")).toBeNull()
  })

  describe("on a phone", () => {
    beforeEach(() => {
      vi.spyOn(pointerModule, "useIsMobileOrCoarse").mockReturnValue(true)
    })

    it("opens as a sheet over the host, with the strip as its handle, and no column", () => {
      openOnHost()
      renderPage()

      const sheet = screen.getByTestId("aside-sheet")
      expect(sheet).toHaveAttribute("data-detent", "peek")
      expect(sheet).toHaveAttribute("data-suppress-pull-refresh", "true")
      expect(screen.getByTestId("aside-sheet-handle")).toBeInTheDocument()
      expect(screen.queryByTestId("aside-panel")).toBeNull()
      expect(screen.getByTestId("stream-content")).toHaveAttribute("data-stream-id", ASIDE)
    })

    it("gives a thread opened while the sheet stands the sheet itself, at the full detent, and hands it back on close", async () => {
      renderPage(`${HOST_PATH}?panel=stream_thread_1`)
      openOnHost()

      const sheet = await screen.findByTestId("aside-sheet")
      expect(sheet).toHaveAttribute("data-view", "panel")
      expect(within(sheet).getByTestId("panel-host")).toBeInTheDocument()
      expect(screen.queryByTestId("aside-pane")).toBeNull()
      await waitFor(() => expect(sheet).toHaveAttribute("data-detent", "full"))

      fireEvent.click(within(sheet).getByTestId("panel-host"))
      await waitFor(() => expect(screen.getByTestId("aside-sheet")).toHaveAttribute("data-view", "aside"))
      expect(screen.getByTestId("aside-pane")).toBeInTheDocument()
      expect(screen.getByTestId("stream-content")).toHaveAttribute("data-stream-id", ASIDE)
    })

    it("shows the thread an aside was opened from under the sheet, not as a panel in it", async () => {
      renderPage(`${HOST_PATH}?panel=stream_host`)
      openOnHost()

      expect(await screen.findByTestId("aside-sheet")).toHaveAttribute("data-view", "aside")
      expect(screen.queryByTestId("panel-host")).toBeNull()
    })

    it("takes the typing with it when opened from a composer, and rests at the peek otherwise", () => {
      // Opened from a row or the palette: nothing held focus, the host stays
      // readable above the peek, and no keyboard rises on its own.
      openOnHost()
      const { unmount } = renderPage()
      expect(screen.getByTestId("stream-content")).not.toHaveAttribute("data-auto-focus")
      unmount()
      resetAsideStoreCache()

      // Opened from the host composer (`/aside`): that composer is now under
      // the sheet, so its focus — and the keyboard — move to the aside's own.
      const hostEditor = document.createElement("div")
      hostEditor.setAttribute("contenteditable", "true")
      hostEditor.tabIndex = 0
      Object.defineProperty(hostEditor, "isContentEditable", { value: true })
      document.body.appendChild(hostEditor)
      act(() => hostEditor.focus())
      try {
        openOnHost()
        renderPage()
        expect(screen.getByTestId("stream-content")).toHaveAttribute("data-auto-focus", "true")
      } finally {
        hostEditor.remove()
      }
    })

    it("gives an open draft the whole sheet, and comes back to the conversation behind it", () => {
      spyOnExport(draftEditorModule, "AsideDraftEditor").mockReturnValue(((props: {
        takeover?: boolean
        onClose: () => void
      }) => (
        <div data-testid="aside-draft-editor" data-takeover={props.takeover ? "true" : undefined}>
          <button type="button" onClick={props.onClose}>
            back
          </button>
        </div>
      )) as never)
      openOnHost()
      renderPage()

      fireEvent.click(screen.getByRole("button", { name: /drafts?$/i }))
      fireEvent.click(screen.getByRole("button", { name: "Start a draft" }))

      // One thing at a time: the draft has the sheet, and the sheet came up to
      // meet it — a writing surface at the peek is chrome and two lines.
      expect(screen.getByTestId("aside-pane")).toHaveAttribute("data-view", "draft")
      expect(screen.getByTestId("aside-draft-editor")).toHaveAttribute("data-takeover", "true")
      expect(screen.queryByTestId("stream-content")).toBeNull()
      expect(screen.queryByRole("separator", { name: "Resize draft" })).toBeNull()
      expect(getAsideSheetDetent()).toBe("full")

      fireEvent.click(screen.getByRole("button", { name: "back" }))
      expect(screen.getByTestId("aside-pane")).toHaveAttribute("data-view", "chat")
      expect(screen.getByTestId("stream-content")).toHaveAttribute("data-stream-id", ASIDE)
    })

    it("closes when the sheet is dragged to the floor, and nothing is left behind", () => {
      openOnHost()
      renderPage()

      const handle = screen.getByTestId("aside-sheet-handle")
      const sheet = screen.getByTestId("aside-sheet")
      // jsdom has no layout: the sheet reports its resting peek height.
      sheet.getBoundingClientRect = () => ({
        height: 360,
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      })
      handle.setPointerCapture = vi.fn()

      fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100 })
      fireEvent.pointerMove(handle, { pointerId: 1, clientY: 500 })
      fireEvent.pointerUp(handle, { pointerId: 1, clientY: 500 })

      // Dragged to the floor: the aside is left, not parked. The anchor row in
      // the host timeline is the way back in.
      expect(getAsideState()).toBeNull()
      expect(screen.queryByTestId("aside-sheet")).toBeNull()
    })

    it("settles back where it was when the browser cancels the gesture mid-drag, committing nothing", () => {
      openOnHost()
      renderPage()

      const handle = screen.getByTestId("aside-sheet-handle")
      const sheet = screen.getByTestId("aside-sheet")
      sheet.getBoundingClientRect = () => ({
        height: 360,
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      })
      handle.setPointerCapture = vi.fn()

      fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100 })
      fireEvent.pointerMove(handle, { pointerId: 1, clientY: 500 })
      fireEvent.pointerCancel(handle, { pointerId: 1, clientY: 500 })

      expect(getAsideSheetDetent()).toBe("peek")
      expect(sheet).toHaveStyle({ height: "45%" })
    })

    it("eases only the settle from a gesture, so a keyboard's viewport change lands instantly", () => {
      openOnHost()
      renderPage()

      const sheet = screen.getByTestId("aside-sheet")
      const handle = screen.getByTestId("aside-sheet-handle")
      expect(sheet.className).not.toContain("transition-[height]")

      vi.useFakeTimers()
      try {
        fireEvent.keyDown(handle, { key: "ArrowUp" })
        expect(getAsideSheetDetent()).toBe("full")
        expect(sheet.className).toContain("transition-[height]")

        // A second settle inside the window restarts it: the ease must outlive
        // the second transition, not end on the first one's clock.
        act(() => vi.advanceTimersByTime(150))
        fireEvent.keyDown(handle, { key: "ArrowDown" })
        act(() => vi.advanceTimersByTime(100))
        expect(sheet.className).toContain("transition-[height]")
        act(() => vi.advanceTimersByTime(150))
        expect(sheet.className).not.toContain("transition-[height]")
      } finally {
        vi.useRealTimers()
      }
    })

    it("reaches the same detents from the keyboard, since the sheet hides the surface picker", () => {
      openOnHost()
      renderPage()

      const handle = screen.getByTestId("aside-sheet-handle")
      expect(handle).toHaveAttribute("tabindex", "0")

      fireEvent.keyDown(handle, { key: "ArrowUp" })
      expect(getAsideSheetDetent()).toBe("full")
      fireEvent.keyDown(handle, { key: "ArrowDown" })
      expect(getAsideSheetDetent()).toBe("peek")
      // The keyboard resizes but never dismisses: a drag to the floor is a
      // deliberate throw-away, an arrow press is not. Closing is the header's job.
      fireEvent.keyDown(handle, { key: "ArrowDown" })
      expect(getAsideSheetDetent()).toBe("peek")
    })

    it("takes the whole viewport once you write in it, and stays there when the keyboard goes", () => {
      openOnHost()
      renderPage()

      const sheet = screen.getByTestId("aside-sheet")
      const editor = document.createElement("div")
      editor.setAttribute("contenteditable", "true")
      editor.tabIndex = 0
      sheet.appendChild(editor)
      Object.defineProperty(editor, "isContentEditable", { value: true })

      expect(sheet).toHaveStyle({ height: "45%" })
      fireEvent.focus(editor)
      expect(sheet).toHaveStyle({ height: "100%" })
      expect(getAsideSheetDetent()).toBe("full")

      // Writing moved the sheet and it stays moved: the keyboard leaving is
      // not a second resize, and a drag is how it comes back down.
      fireEvent.blur(editor)
      expect(sheet).toHaveStyle({ height: "100%" })
      expect(getAsideSheetDetent()).toBe("full")
    })

    it("keeps the keyboard through a fold of the drafts tray", () => {
      openOnHost()
      renderPage()

      const sheet = screen.getByTestId("aside-sheet")
      const editor = document.createElement("div")
      editor.setAttribute("contenteditable", "true")
      editor.tabIndex = 0
      sheet.appendChild(editor)
      Object.defineProperty(editor, "isContentEditable", { value: true })
      act(() => editor.focus())
      expect(sheet).toHaveStyle({ height: "100%" })

      // The tray is chrome, not a focus target: the tap is prevented before it
      // reaches focus, so the keyboard stays up and the sheet stays put.
      const toggle = screen.getByRole("button", { name: /drafts?$/i })
      expect(fireEvent.mouseDown(toggle)).toBe(false)
      fireEvent.click(toggle)

      expect(toggle).toHaveAttribute("aria-expanded", "true")
      expect(document.activeElement).toBe(editor)
      expect(sheet).toHaveStyle({ height: "100%" })
      expect(getAsideSheetDetent()).toBe("full")
    })

    it("resizes while the composer keeps focus — a drag never closes the keyboard", () => {
      openOnHost()
      renderPage()

      const handle = screen.getByTestId("aside-sheet-handle")
      const sheet = screen.getByTestId("aside-sheet")
      const editor = document.createElement("div")
      editor.setAttribute("contenteditable", "true")
      editor.tabIndex = 0
      sheet.appendChild(editor)
      Object.defineProperty(editor, "isContentEditable", { value: true })
      act(() => editor.focus())
      expect(sheet).toHaveStyle({ height: "100%" })
      sheet.getBoundingClientRect = () => ({
        height: 360,
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      })
      handle.setPointerCapture = vi.fn()

      // Pull up to full, like the composer's own resize handle: preventDefault
      // on pointerdown keeps focus — and the keyboard — where it is.
      const down = fireEvent.pointerDown(handle, { pointerId: 1, clientY: 500 })
      expect(down).toBe(false)
      fireEvent.pointerMove(handle, { pointerId: 1, clientY: 100 })
      fireEvent.pointerUp(handle, { pointerId: 1, clientY: 100 })

      expect(document.activeElement).toBe(editor)
      expect(getAsideSheetDetent()).toBe("full")
      expect(handle.setPointerCapture).toHaveBeenCalled()
    })
  })
})
