import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { StreamTypes } from "@threa/types"
import { spyOnExport } from "@/test"
import { createMockStream } from "@/test/fixtures"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as useMobileModule from "@/hooks/use-mobile"
import * as timelineModule from "@/components/timeline"
import * as boundaryModule from "@/components/stream-error-boundary"
import { useAgentBlock } from "@/components/timeline/agent-block-context"
import * as draftEditorModule from "./aside-draft-editor"
import { clearCallState } from "@/stores/call-store"
import { __resetCallPrefsForTests } from "@/stores/call-prefs-store"
import { getAsideSheetDetent, getAsideState, openAside, resetAsideStoreCache } from "@/stores/aside-store"
import { AsideSlot, useAsideHost } from "./index"

const HOST_PATH = "/w/ws_1/s/stream_host"
const ASIDE = "stream_aside_1"
const aside = createMockStream({
  id: ASIDE,
  type: StreamTypes.ASIDE,
  displayName: "churn number sanity-check",
  parentStreamId: "stream_host",
  parentAnchorId: "msg_anchor_1",
})

/**
 * The page's mount point, bound to the route like the stream page binds it.
 * `takeover` is the phone's panel takeover: the main column is hidden and
 * inert, so only the aside can draw.
 */
function Page({ takeover = false }: { takeover?: boolean }) {
  const hostKey = useAsideHost()
  return (
    <div className="flex">
      <main className="relative" inert={takeover || undefined} hidden={takeover}></main>
      <AsideSlot workspaceId="ws_1" hostKey={hostKey} />
    </div>
  )
}

function renderPage(path = HOST_PATH, options: { takeover?: boolean } = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/w/:workspaceId/s/:streamId" element={<Page takeover={options.takeover} />} />
        <Route path="/w/:workspaceId/board" element={<Page takeover={options.takeover} />} />
      </Routes>
    </MemoryRouter>
  )
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
  // The chat pane is the real companion timeline; its data plumbing is out of
  // scope here, so the barrel export renders a marker carrying the stream it
  // was mounted against.
  spyOnExport(timelineModule, "StreamContent").mockReturnValue(((props: {
    streamId: string
    hideComposer?: boolean
  }) => (
    <div
      data-testid="stream-content"
      data-stream-id={props.streamId}
      data-composer={props.hideComposer ? "hidden" : "shown"}
    />
  )) as never)
  spyOnExport(boundaryModule, "StreamErrorBoundary").mockReturnValue(((props: { children: React.ReactNode }) => (
    <>{props.children}</>
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

    // The queue is the aside's, not the surface's: a block that has not reached
    // an editor yet survives the editor remounting (this mock never consumes it).
    expect(editor).toHaveAttribute("data-pending", "persona_01ARIADNE")
  })

  it("folds the drafts to their count, and unfolds to the tray on the chevron", async () => {
    spyOnExport(draftEditorModule, "AsideDraftEditor").mockReturnValue((() => <div />) as never)
    renderPage()
    openOnHost()

    // Resting state is the count, the way the composer's attachment tray rests.
    const fold = await screen.findByRole("button", { name: /drafts?$/i })
    expect(fold).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByRole("button", { name: "New draft" })).toBeNull()

    fireEvent.click(fold)
    expect(fold).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByRole("button", { name: "New draft" })).toBeInTheDocument()
  })

  it("divides the aside between the draft and the conversation on a drag, keyboard included", async () => {
    spyOnExport(draftEditorModule, "AsideDraftEditor").mockReturnValue((() => <div />) as never)
    renderPage()
    openOnHost()

    fireEvent.click(await screen.findByRole("button", { name: /drafts?$/i }))
    fireEvent.click(screen.getByRole("button", { name: "New draft" }))

    const drafts = await screen.findByTestId("aside-drafts")
    expect(drafts).toHaveStyle({ height: "320px" })

    const divider = screen.getByRole("separator", { name: "Resize draft" })
    divider.setPointerCapture = vi.fn()
    divider.releasePointerCapture = vi.fn()
    fireEvent.pointerDown(divider, { pointerId: 1, clientY: 400, isPrimary: true, button: 0 })
    fireEvent.pointerMove(divider, { pointerId: 1, clientY: 460 })
    fireEvent.pointerUp(divider, { pointerId: 1, clientY: 460 })
    await waitFor(() => expect(screen.getByTestId("aside-drafts")).toHaveStyle({ height: "380px" }))

    fireEvent.keyDown(divider, { key: "ArrowUp", shiftKey: true })
    await waitFor(() => expect(screen.getByTestId("aside-drafts")).toHaveStyle({ height: "316px" }))
  })

  it("should render no aside chrome while nothing is open on this page", () => {
    renderPage()
    expect(screen.queryByTestId("aside-stage")).toBeNull()
  })

  it("puts the host beside the aside on one stage, and only the aside can be written in", async () => {
    renderPage()
    openOnHost()

    expect(await screen.findByTestId("aside-stage")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "churn number sanity-check" })).toBeInTheDocument()
    // The host is what you are answering, not a second place to write: its
    // composer is absent, and the aside's is the only one on the stage.
    expect(
      screen
        .getAllByTestId("stream-content")
        .map((node) => [node.getAttribute("data-stream-id"), node.getAttribute("data-composer")])
    ).toEqual([
      ["stream_host", "hidden"],
      [ASIDE, "shown"],
    ])
    expect(screen.getByText("read only")).toBeInTheDocument()
    // One surface: nothing to pick between, and nothing to park into.
    expect(screen.queryByRole("group", { name: "Aside surface" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Minimize aside" })).toBeNull()
  })

  it("names the aside as private and points back at the message it was opened from", async () => {
    renderPage()
    openOnHost()

    expect(await screen.findByText("Private")).toBeInTheDocument()
    // Anchored to a message that isn't in this test's timeline cache: it names
    // the host stream rather than inventing an author, and the sentence itself
    // is the jump — there is no separate "scroll to it" to hunt for.
    const jump = screen.getByTestId("aside-anchor-line")
    expect(jump).toHaveAttribute("href", `${HOST_PATH}?m=msg_anchor_1`)
    expect(jump).toHaveTextContent(/^Anchored in/)
  })

  it("divides the stage between the host and the aside on a drag, keyboard included", async () => {
    // jsdom reports no layout, so the stage falls back to the viewport for its
    // cap; a 1024px default would clamp every drag below the default width.
    Object.defineProperty(window, "innerWidth", { value: 1600, configurable: true })
    renderPage()
    openOnHost()

    const handle = await screen.findByRole("separator", { name: "Resize aside" })
    const column = () => screen.getByTestId("aside-drafts").parentElement as HTMLElement
    expect(column()).toHaveStyle({ width: "620px" })

    handle.setPointerCapture = vi.fn()
    handle.releasePointerCapture = vi.fn()
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 1000, isPrimary: true, button: 0 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 900 })
    await waitFor(() => expect(column()).toHaveStyle({ width: "720px" }))

    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true })
    await waitFor(() => expect(column()).toHaveStyle({ width: "770px" }))
    fireEvent.keyDown(handle, { key: "ArrowRight" })
    await waitFor(() => expect(column()).toHaveStyle({ width: "760px" }))
  })

  it("should leave nothing behind on close", async () => {
    renderPage()
    openOnHost()
    fireEvent.click(await screen.findByRole("button", { name: "Close aside" }))

    expect(getAsideState()).toBeNull()
    expect(screen.queryByTestId("aside-stage")).toBeNull()
  })

  it("should drop the aside when its host page goes away", async () => {
    const view = renderPage()
    openOnHost()
    await screen.findByTestId("aside-stage")

    view.unmount()
    expect(getAsideState()).toBeNull()
  })

  it("should not show another page's aside", () => {
    openOnHost()
    renderPage("/w/ws_1/board")
    expect(screen.queryByTestId("aside-stage")).toBeNull()
  })

  describe("on a phone", () => {
    beforeEach(() => {
      vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
    })

    it("opens as a sheet over the host, with the strip as its handle, and no desktop dock", () => {
      openOnHost()
      renderPage()

      const sheet = screen.getByTestId("aside-sheet")
      expect(sheet).toHaveAttribute("data-detent", "peek")
      expect(sheet).toHaveAttribute("data-suppress-pull-refresh", "true")
      expect(screen.getByTestId("aside-sheet-handle")).toBeInTheDocument()
      expect(screen.queryByTestId("aside-stage")).toBeNull()
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
      expect(sheet).toHaveStyle({ height: "45dvh" })
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

    it("rises to the full viewport while an editor in it has focus, and settles back when the keyboard goes", () => {
      openOnHost()
      renderPage()

      const sheet = screen.getByTestId("aside-sheet")
      const editor = document.createElement("div")
      editor.setAttribute("contenteditable", "true")
      editor.tabIndex = 0
      sheet.appendChild(editor)
      Object.defineProperty(editor, "isContentEditable", { value: true })

      expect(sheet).toHaveStyle({ height: "45dvh" })
      fireEvent.focus(editor)
      expect(sheet).toHaveStyle({ height: "100dvh" })
      expect(sheet).toHaveAttribute("data-keyboard-lift", "true")
      // The chosen detent is presentation-independent: still the peek.
      expect(getAsideSheetDetent()).toBe("peek")

      fireEvent.blur(editor)
      expect(sheet).toHaveStyle({ height: "45dvh" })
      expect(sheet).not.toHaveAttribute("data-keyboard-lift")
    })

    it("resizes while the composer keeps focus — a drag never closes the keyboard, and it overrides the lift", () => {
      openOnHost()
      renderPage()

      const handle = screen.getByTestId("aside-sheet-handle")
      const sheet = screen.getByTestId("aside-sheet")
      const editor = document.createElement("div")
      editor.setAttribute("contenteditable", "true")
      editor.tabIndex = 0
      sheet.appendChild(editor)
      Object.defineProperty(editor, "isContentEditable", { value: true })
      editor.focus()
      fireEvent.focus(editor)
      expect(sheet).toHaveStyle({ height: "100dvh" })
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
      expect(sheet).not.toHaveAttribute("data-keyboard-lift")
    })
  })
})
