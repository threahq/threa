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
import { clearCallState, setCallPhase, setCallSession, setDesktopSurfaceOverride } from "@/stores/call-store"
import { __resetCallPrefsForTests } from "@/stores/call-prefs-store"
import { getAsideState, openAside, resetAsideStoreCache } from "@/stores/aside-store"
import { resolveAsideOpenSurface } from "@/lib/aside/surface"
import { AsideDockSlot, AsideMinimizedStrip, useAsideHost } from "./index"
import { isCallDocked } from "./use-call-docked"

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
 * The page's two mount points, bound to the route like the stream page binds
 * them. `takeover` is the phone's panel takeover: the main column (and the
 * strip inside it) is hidden and inert, so only the dock slot can draw.
 */
function Page({ takeover = false }: { takeover?: boolean }) {
  const hostKey = useAsideHost()
  return (
    <div className="flex">
      <main className="relative" inert={takeover || undefined} hidden={takeover}>
        <AsideMinimizedStrip workspaceId="ws_1" hostKey={hostKey} />
      </main>
      <AsideDockSlot workspaceId="ws_1" hostKey={hostKey} />
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

function openOnHost(surface: "dock" | "fullscreen" | "minimized" = "dock") {
  openAside({
    hostKey: HOST_PATH,
    hostStreamId: "stream_host",
    asideId: ASIDE,
    surface,
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
    spyOnExport(timelineModule, "StreamContent").mockReturnValue((() => {
      const agentBlock = useAgentBlock()
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
    openOnHost("dock")

    fireEvent.click(await screen.findByRole("button", { name: "insert into draft" }))

    const editor = await screen.findByTestId("aside-draft-editor")
    expect(editor.getAttribute("data-draft-scope")).toMatch(/^aside:stream_aside_1:draft_/)
    expect(editor).toHaveAttribute("data-pending", "persona_01ARIADNE")
    // The chat timeline is out of the way while the draft is open, and the
    // block went nowhere else.
    expect(screen.queryByRole("button", { name: "insert into draft" })).toBeNull()
  })

  it("should render no aside chrome while nothing is open on this page", () => {
    renderPage()
    expect(screen.queryByTestId("aside-dock")).toBeNull()
    expect(screen.queryByTestId("aside-strip")).toBeNull()
  })

  it("should dock the companion timeline against the aside and switch surfaces from the header", async () => {
    renderPage()
    openOnHost("dock")

    const dock = await screen.findByTestId("aside-dock")
    expect(dock).toHaveAttribute("data-surface", "dock")
    expect(dock).toHaveStyle({ width: "400px" })
    expect(screen.getByTestId("stream-content")).toHaveAttribute("data-stream-id", ASIDE)
    expect(screen.getByRole("heading", { name: "churn number sanity-check" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Dock aside" })).toHaveAttribute("aria-pressed", "true")

    fireEvent.click(screen.getByRole("button", { name: "Aside fullscreen" }))
    expect(screen.getByTestId("aside-dock")).toHaveAttribute("data-surface", "fullscreen")
    expect(getAsideState()?.surface).toBe("fullscreen")

    fireEvent.click(screen.getByRole("button", { name: "Minimize aside" }))
    await waitFor(() => expect(screen.queryByTestId("aside-dock")).toBeNull())
    expect(screen.getByTestId("aside-strip")).toHaveTextContent("churn number sanity-check")
  })

  it("names the aside as private and points back at the message it was opened from", async () => {
    renderPage()
    openOnHost("dock")

    expect(await screen.findByText("Only you")).toBeInTheDocument()
    // Anchored to a message that isn't in this test's timeline cache: it names
    // the host stream rather than inventing an author, and still offers the jump.
    const jump = screen.getByRole("link", { name: "Scroll to it" })
    expect(jump).toHaveAttribute("href", `${HOST_PATH}?m=msg_anchor_1`)
    expect(screen.getByText(/^Anchored in/)).toBeInTheDocument()
  })

  it("resizes the dock from its handle, keyboard included, and holds the width across a surface round trip", async () => {
    // The sketch asks for the dock to be resizable like the thread panel and
    // the call dock; before this it was a hardcoded 400.
    renderPage()
    openOnHost("dock")

    const handle = await screen.findByRole("separator", { name: "Resize aside" })
    handle.setPointerCapture = vi.fn()
    handle.releasePointerCapture = vi.fn()
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 1000, isPrimary: true, button: 0 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 900 })
    await waitFor(() => expect(screen.getByTestId("aside-dock")).toHaveStyle({ width: "500px" }))

    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true })
    await waitFor(() => expect(screen.getByTestId("aside-dock")).toHaveStyle({ width: "550px" }))
    fireEvent.keyDown(handle, { key: "ArrowRight" })
    await waitFor(() => expect(screen.getByTestId("aside-dock")).toHaveStyle({ width: "540px" }))

    // Fullscreen owns its own geometry; coming back lands on the dragged width.
    fireEvent.click(screen.getByRole("button", { name: "Aside fullscreen" }))
    expect(screen.queryByRole("separator", { name: "Resize aside" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Dock aside" }))
    await waitFor(() => expect(screen.getByTestId("aside-dock")).toHaveStyle({ width: "540px" }))
  })

  it("should restore a minimized aside into the surface it was last read in, and close from the strip", async () => {
    renderPage()
    openOnHost("fullscreen")
    fireEvent.click(await screen.findByRole("button", { name: "Minimize aside" }))
    await waitFor(() => expect(screen.queryByTestId("aside-dock")).toBeNull())

    fireEvent.click(screen.getByRole("button", { name: "Open aside: churn number sanity-check" }))
    expect(await screen.findByTestId("aside-dock")).toHaveAttribute("data-surface", "fullscreen")
    expect(screen.queryByTestId("aside-strip")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Minimize aside" }))
    fireEvent.click(await screen.findByRole("button", { name: "Close aside" }))
    expect(getAsideState()).toBeNull()
    await waitFor(() => expect(screen.queryByTestId("aside-strip")).toBeNull())
  })

  it("should fold the dock away on close and leave no chrome", async () => {
    renderPage()
    openOnHost("dock")
    fireEvent.click(await screen.findByRole("button", { name: "Close aside" }))

    expect(getAsideState()).toBeNull()
    // The slot snaps to zero width first (the fold), then unmounts.
    expect(screen.getByTestId("aside-dock")).toHaveStyle({ width: "0px" })
    await waitFor(() => expect(screen.queryByTestId("aside-dock")).toBeNull())
    expect(screen.queryByTestId("aside-strip")).toBeNull()
  })

  it("should drop the aside when its host page goes away", async () => {
    const view = renderPage()
    openOnHost("dock")
    await screen.findByTestId("aside-dock")

    view.unmount()
    expect(getAsideState()).toBeNull()
  })

  it("should not show another page's aside", () => {
    openOnHost("dock")
    renderPage("/w/ws_1/board")
    expect(screen.queryByTestId("aside-dock")).toBeNull()
    expect(screen.queryByTestId("aside-strip")).toBeNull()
  })

  describe("right-edge contention with a docked call", () => {
    beforeEach(() => {
      setCallSession({ callId: "call_1", workspaceId: "ws_1", streamId: "stream_call", mode: "audio_only" })
      setCallPhase("connected")
      setDesktopSurfaceOverride("sidebar")
    })

    it("should open minimized instead of docking while a call owns the right edge", async () => {
      expect(isCallDocked()).toBe(true)
      renderPage()
      openOnHost(resolveAsideOpenSurface({ remembered: null, callDocked: isCallDocked() }))

      expect(await screen.findByTestId("aside-strip")).toBeInTheDocument()
      expect(screen.queryByTestId("aside-dock")).toBeNull()
    })

    it("should restore from the strip into fullscreen and keep the dock control disabled", async () => {
      renderPage()
      openOnHost("minimized")
      fireEvent.click(await screen.findByRole("button", { name: "Open aside: churn number sanity-check" }))

      expect(await screen.findByTestId("aside-dock")).toHaveAttribute("data-surface", "fullscreen")
      expect(screen.getByRole("button", { name: "Dock aside" })).toBeDisabled()
    })

    it("should dock again once the call floats", async () => {
      setDesktopSurfaceOverride("floating")
      expect(isCallDocked()).toBe(false)
      renderPage()
      openOnHost(resolveAsideOpenSurface({ remembered: null, callDocked: isCallDocked() }))

      expect(await screen.findByTestId("aside-dock")).toHaveAttribute("data-surface", "dock")
      expect(screen.getByRole("button", { name: "Dock aside" })).toBeEnabled()
    })
  })

  describe("on a phone", () => {
    beforeEach(() => {
      vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
    })

    it("opens as a sheet over the host, with the strip as its handle, and no desktop dock", () => {
      openOnHost()
      renderPage()

      const sheet = screen.getByTestId("aside-sheet")
      expect(sheet).toHaveAttribute("data-surface", "dock")
      expect(sheet).toHaveAttribute("data-suppress-pull-refresh", "true")
      expect(screen.getByTestId("aside-sheet-handle")).toBeInTheDocument()
      expect(screen.queryByTestId("aside-dock")).toBeNull()
      expect(screen.getByTestId("stream-content")).toHaveAttribute("data-stream-id", ASIDE)
    })

    it("parks in the strip when the sheet is dragged to the floor, and nothing else is left behind", () => {
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

      expect(getAsideState()?.surface).toBe("minimized")
      expect(screen.queryByTestId("aside-sheet")).toBeNull()
      expect(screen.getByTestId("aside-strip")).toBeInTheDocument()
    })

    it("keeps the parked strip reachable under a panel takeover, where the main column is hidden", () => {
      openOnHost("minimized")
      renderPage(HOST_PATH, { takeover: true })

      const strip = screen.getByTestId("aside-strip")
      expect(strip).toBeVisible()
      expect(strip.closest("main")).toBeNull()
      expect(screen.getAllByTestId("aside-strip")).toHaveLength(1)
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

      expect(getAsideState()?.surface).toBe("dock")
      expect(sheet).toHaveStyle({ height: "45dvh" })
    })

    it("reaches the same detents from the keyboard, since the sheet hides the surface picker", () => {
      openOnHost()
      renderPage()

      const handle = screen.getByTestId("aside-sheet-handle")
      expect(handle).toHaveAttribute("tabindex", "0")

      fireEvent.keyDown(handle, { key: "ArrowUp" })
      expect(getAsideState()?.surface).toBe("fullscreen")
      fireEvent.keyDown(handle, { key: "ArrowDown" })
      expect(getAsideState()?.surface).toBe("dock")
      fireEvent.keyDown(handle, { key: "ArrowDown" })
      expect(getAsideState()?.surface).toBe("minimized")
      expect(screen.getByTestId("aside-strip")).toBeInTheDocument()
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
      expect(getAsideState()?.surface).toBe("dock")

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
      expect(getAsideState()?.surface).toBe("fullscreen")
      expect(handle.setPointerCapture).toHaveBeenCalled()
      expect(sheet).not.toHaveAttribute("data-keyboard-lift")
    })
  })
})
