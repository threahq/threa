import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { StreamTypes } from "@threa/types"
import { spyOnExport } from "@/test"
import { createMockStream } from "@/test/fixtures"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as pointerModule from "@/hooks/use-pointer"
import * as timelineModule from "@/components/timeline"
import * as boundaryModule from "@/components/stream-error-boundary"
import { useAgentBlock } from "@/components/timeline/agent-block-context"
import * as draftEditorModule from "./aside-draft-editor"
import { clearCallState } from "@/stores/call-store"
import { __resetCallPrefsForTests } from "@/stores/call-prefs-store"
import {
  ASIDE_DRAFT_DEFAULT_HEIGHT,
  ASIDE_STAGE_DEFAULT_WIDTH,
  getAsideSheetDetent,
  getAsideState,
  openAside,
  resetAsideStoreCache,
} from "@/stores/aside-store"
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

function routes(path = HOST_PATH, options: { takeover?: boolean } = {}) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/w/:workspaceId/s/:streamId" element={<Page takeover={options.takeover} />} />
        <Route path="/w/:workspaceId/board" element={<Page takeover={options.takeover} />} />
      </Routes>
    </MemoryRouter>
  )
}

function renderPage(path = HOST_PATH, options: { takeover?: boolean } = {}) {
  return render(routes(path, options))
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
  spyOnExport(timelineModule, "StreamContent").mockReturnValue(((props: { streamId: string }) => (
    <div data-testid="stream-content" data-stream-id={props.streamId} />
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
    expect(screen.queryByTestId("aside-stage")).toBeNull()
  })

  it("puts the host beside the aside on one stage, both of them live", async () => {
    renderPage()
    openOnHost()

    expect(await screen.findByTestId("aside-stage")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "churn number sanity-check" })).toBeInTheDocument()
    // The host keeps its own composer: a quick line into the channel should not
    // cost you the aside.
    expect(screen.getAllByTestId("stream-content").map((node) => node.getAttribute("data-stream-id"))).toEqual([
      "stream_host",
      ASIDE,
    ])
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
    expect(column()).toHaveStyle({ width: `${ASIDE_STAGE_DEFAULT_WIDTH}px` })

    handle.setPointerCapture = vi.fn()
    handle.releasePointerCapture = vi.fn()
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 1000, isPrimary: true, button: 0 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 900 })
    await waitFor(() => expect(column()).toHaveStyle({ width: `${ASIDE_STAGE_DEFAULT_WIDTH + 100}px` }))

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
      vi.spyOn(pointerModule, "useIsMobileOrCoarse").mockReturnValue(true)
    })

    it("opens as a sheet over the host, with the strip as its handle, and no stage", () => {
      openOnHost()
      renderPage()

      const sheet = screen.getByTestId("aside-sheet")
      expect(sheet).toHaveAttribute("data-detent", "peek")
      expect(sheet).toHaveAttribute("data-suppress-pull-refresh", "true")
      expect(screen.getByTestId("aside-sheet-handle")).toBeInTheDocument()
      expect(screen.queryByTestId("aside-stage")).toBeNull()
      expect(screen.getByTestId("stream-content")).toHaveAttribute("data-stream-id", ASIDE)
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

    it("takes the whole viewport once you write in it, and stays there when the keyboard goes", () => {
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
      expect(getAsideSheetDetent()).toBe("full")

      // Writing moved the sheet and it stays moved: the keyboard leaving is
      // not a second resize, and a drag is how it comes back down.
      fireEvent.blur(editor)
      expect(sheet).toHaveStyle({ height: "100dvh" })
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
      expect(sheet).toHaveStyle({ height: "100dvh" })

      // The tray is chrome, not a focus target: the tap is prevented before it
      // reaches focus, so the keyboard stays up and the sheet stays put.
      const toggle = screen.getByRole("button", { name: /drafts?$/i })
      expect(fireEvent.mouseDown(toggle)).toBe(false)
      fireEvent.click(toggle)

      expect(toggle).toHaveAttribute("aria-expanded", "true")
      expect(document.activeElement).toBe(editor)
      expect(sheet).toHaveStyle({ height: "100dvh" })
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
    })
  })
})
