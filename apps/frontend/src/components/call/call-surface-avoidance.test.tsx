import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act, cleanup, fireEvent } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { render, screen } from "@/test"
import * as authModule from "@/auth"
import * as ringTone from "@/calls/ring-tone"
import { seedWorkspaceCache, resetWorkspaceStoreCache } from "@/stores/workspace-store"
import {
  clearCallState,
  setCallSession,
  setCallPhase,
  setCallRoster,
  type CallRosterParticipant,
} from "@/stores/call-store"
import { __resetCallPrefsForTests } from "@/stores/call-prefs-store"
import { addIncomingCall, resetIncomingCallStoreCache, type IncomingCall } from "@/stores/incoming-call-store"
import type { CallController } from "@/calls/call-manager"
import { getFloatingSurfaceGeometry } from "@/stores/floating-surface-geometry-store"
import { FloatingCallSquare } from "./floating-call-square"
import { IncomingCallOverlay } from "./incoming-call-overlay"
import { CallManagerProvider } from "./call-manager-context"
import { CallLaunchProvider, useCallLaunch } from "./call-launch-context"

const WORKSPACE_ID = "workspace_1"

// jsdom lays nothing out, so the ring stack's rect is emulated the way the browser
// resolves its CSS anchor: 320px wide, 16px from the bottom-right corner, one 72px
// card per ring with an 8px gap — plus whatever translation the component applied,
// exactly as a real getBoundingClientRect would report it.
const CARD_HEIGHT = 72
const CARD_GAP = 8
const RING_WIDTH = 320
const RING_INSET = 16

const EMPTY_RECT = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) }

const EXPANDED_SIZE = { width: 340, height: 320 }
const MINIMIZED_SIZE = { width: 380, height: 50 }

function domRect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) } as DOMRect
}

function appliedTranslate(el: HTMLElement): { x: number; y: number } {
  const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform)
  return match ? { x: Number(match[1]), y: Number(match[2]) } : { x: 0, y: 0 }
}

// jsdom lays nothing out, so both surfaces are emulated where the browser would
// resolve their CSS — the square from its committed left/top, its marked groups
// where its flex layout puts them (the header band across the top, the controls
// row centred along the bottom, PreJoinGate actions centred in the body). Without
// this the measured rects are all-zero and the avoidance policy is never exercised
// on anything but the fallback. Each group is identified by what it *is* — the
// header's test id, the presence of the Leave control — never by a utility class
// or a button count, so restyling the surface can't silently re-map the emulation
// onto the wrong region.
const HEADER_HEIGHT = 45

function squareBox(square: HTMLElement) {
  const size = square.dataset.minimized === "true" ? MINIMIZED_SIZE : EXPANDED_SIZE
  return { x: Number.parseFloat(square.style.left), y: Number.parseFloat(square.style.top), ...size }
}

function protectedGroupRect(el: HTMLElement, square: HTMLElement): DOMRect {
  const box = squareBox(square)
  // The minimized bar is its own protected root.
  if (el === square) return domRect(box.x, box.y, box.width, box.height)
  if (el.dataset.testid === "floating-call-square-header") {
    return domRect(box.x, box.y, box.width, HEADER_HEIGHT)
  }
  if (el.querySelector('[aria-label="Leave call"]')) {
    return domRect(box.x + 47, box.y + box.height - 44, 246, 36)
  }
  return domRect(box.x + 54, box.y + 40 + (box.height - 40) / 2 - 52, 232, 104)
}

function installSurfaceLayout() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === "incoming-call-overlay") {
      const cards = this.querySelectorAll('[role="alert"]').length
      const height = cards * CARD_HEIGHT + Math.max(0, cards - 1) * CARD_GAP
      const applied = appliedTranslate(this)
      return domRect(
        window.innerWidth - RING_INSET - RING_WIDTH + applied.x,
        window.innerHeight - RING_INSET - height + applied.y,
        RING_WIDTH,
        height
      )
    }
    const square = this.closest('[data-testid="floating-call-square"]') as HTMLElement | null
    if (!square) return EMPTY_RECT as DOMRect
    if (this === square && !this.hasAttribute("data-call-surface-protected")) {
      const box = squareBox(square)
      return domRect(box.x, box.y, box.width, box.height)
    }
    if (!this.hasAttribute("data-call-surface-protected")) return EMPTY_RECT as DOMRect
    return protectedGroupRect(this, square)
  })
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width })
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: height })
}

function makeManager(overrides: Partial<CallController> = {}): CallController {
  return {
    startCall: vi.fn(async () => {}),
    leaveCall: vi.fn(async () => {}),
    setMuted: vi.fn(),
    setCameraOn: vi.fn(async () => {}),
    switchInputDevice: vi.fn(async () => {}),
    switchCameraDevice: vi.fn(async () => {}),
    flipCamera: vi.fn(async () => {}),
    setOutputDevice: vi.fn(async () => {}),
    getVideoStream: vi.fn(() => null),
    setCallTitle: vi.fn(),
    ...overrides,
  }
}

function makeRing(overrides: Partial<IncomingCall> = {}): IncomingCall {
  return {
    attemptId: "callinv_1",
    callId: "call_1",
    workspaceId: WORKSPACE_ID,
    streamId: "stream_dm",
    inviterId: "usr_peer",
    inviterName: "Grace",
    mode: "video",
    expiresAtMs: Date.now() + 45_000,
    ...overrides,
  }
}

const SELF: CallRosterParticipant = {
  userId: "usr_self",
  participantStatus: "joined",
  endpointId: "callep_self",
  connectionStatus: "connected",
  mediaState: {},
  publishedTracks: [],
}

function LaunchButton() {
  const { launch } = useCallLaunch()
  return (
    <button type="button" onClick={() => launch({ workspaceId: WORKSPACE_ID, streamId: "stream_1", mode: "video" })}>
      launch
    </button>
  )
}

function renderBothSurfaces(manager: CallController = makeManager()) {
  return render(
    <MemoryRouter>
      <CallManagerProvider manager={manager}>
        <CallLaunchProvider>
          <LaunchButton />
          <FloatingCallSquare workspaceId={WORKSPACE_ID} streamId="stream_1" onSelectSurface={vi.fn()} />
          <IncomingCallOverlay workspaceId={WORKSPACE_ID} />
        </CallLaunchProvider>
      </CallManagerProvider>
    </MemoryRouter>
  )
}

function enterConnected() {
  act(() => {
    setCallSession({ callId: "call_live", workspaceId: WORKSPACE_ID, streamId: "stream_1", mode: "video" })
    setCallPhase("connected")
    setCallRoster([SELF], 1)
  })
}

function squareRect() {
  const square = screen.getByTestId("floating-call-square")
  const minimized = square.getAttribute("data-minimized") === "true"
  return {
    x: Number.parseFloat(square.style.left),
    y: Number.parseFloat(square.style.top),
    width: minimized ? 380 : 340,
    height: minimized ? 50 : 320,
  }
}

function ringRect() {
  const overlay = screen.getByTestId("incoming-call-overlay")
  const box = overlay.getBoundingClientRect()
  return { x: box.left, y: box.top, width: box.width, height: box.height }
}

function overlapsRect(a: { x: number; y: number; width: number; height: number }) {
  const r = ringRect()
  return r.x < a.x + a.width && a.x < r.x + r.width && r.y < a.y + a.height && a.y < r.y + r.height
}

function overlapsSquare() {
  return overlapsRect(squareRect())
}

function protectedRects() {
  return getFloatingSurfaceGeometry()?.protectedRects ?? []
}

function fullyOnScreen(margin = 8) {
  const r = ringRect()
  return (
    r.x >= margin &&
    r.y >= margin &&
    r.x + r.width <= window.innerWidth - margin &&
    r.y + r.height <= window.innerHeight - margin
  )
}

function dragSquareTo(x: number, y: number) {
  const header = screen.getByTestId("floating-call-square-header")
  header.setPointerCapture = vi.fn()
  const start = squareRect()
  act(() => {
    fireEvent.pointerDown(header, { clientX: start.x, clientY: start.y, pointerId: 1, isPrimary: true })
    fireEvent.pointerMove(header, { clientX: x, clientY: y, pointerId: 1 })
    fireEvent.pointerUp(header, { clientX: x, clientY: y, pointerId: 1 })
  })
}

beforeEach(() => {
  setViewport(1024, 768)
  clearCallState()
  resetWorkspaceStoreCache()
  resetIncomingCallStoreCache()
  localStorage.clear()
  __resetCallPrefsForTests()
  seedWorkspaceCache(WORKSPACE_ID, {
    workspace: {
      id: WORKSPACE_ID,
      name: "Workspace",
      slug: "workspace",
      createdAt: "2026-03-01T10:00:00Z",
      updatedAt: "2026-03-01T10:00:00Z",
      _cachedAt: Date.now(),
    },
    users: [],
    streams: [],
    memberships: [],
    dmPeers: [],
    personas: [],
    bots: [],
  })
  vi.spyOn(authModule, "useUser").mockReturnValue({ id: "workos_self" } as ReturnType<typeof authModule.useUser>)
  vi.spyOn(ringTone, "installRingAudioWarmup").mockReturnValue(() => {})
  vi.spyOn(ringTone, "startRing").mockReturnValue(true)
  vi.spyOn(ringTone, "stopRing").mockReturnValue(undefined)
  installSurfaceLayout()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  resetIncomingCallStoreCache()
  clearCallState()
  setViewport(1024, 768)
})

describe("incoming ring ↔ floating call square", () => {
  it("leaves the ring in its corner when no floating surface is mounted", () => {
    render(
      <MemoryRouter>
        <CallLaunchProvider>
          <IncomingCallOverlay workspaceId={WORKSPACE_ID} />
        </CallLaunchProvider>
      </MemoryRouter>
    )
    act(() => addIncomingCall(makeRing()))
    expect(screen.getByTestId("incoming-call-overlay").style.transform).toBe("")
  })

  it("lifts a ring that arrives over the square, and keeps both surfaces usable", () => {
    renderBothSurfaces()
    enterConnected()
    act(() => addIncomingCall(makeRing()))

    expect(screen.getByTestId("incoming-call-overlay").style.transform).not.toBe("")
    expect(overlapsSquare()).toBe(false)
    expect(fullyOnScreen()).toBe(true)
    expect(screen.getByLabelText("Accept call")).toBeInTheDocument()
    expect(screen.getByLabelText("Minimize call")).toBeInTheDocument()
  })

  it("re-resolves live while the square is dragged under and away from the ring", () => {
    renderBothSurfaces()
    enterConnected()
    act(() => addIncomingCall(makeRing()))
    expect(overlapsSquare()).toBe(false)

    dragSquareTo(40, 40)
    expect(screen.getByTestId("incoming-call-overlay").style.transform).toBe("")
    expect(overlapsSquare()).toBe(false)

    dragSquareTo(700, 500)
    expect(overlapsSquare()).toBe(false)
    expect(fullyOnScreen()).toBe(true)
  })

  it("tracks the minimized bar — a smaller obstacle needs a smaller lift", () => {
    renderBothSurfaces()
    enterConnected()
    act(() => addIncomingCall(makeRing()))
    const expandedLift = appliedTranslate(screen.getByTestId("incoming-call-overlay")).y

    act(() => {
      fireEvent.click(screen.getByLabelText("Minimize call"), { clientX: 1000, clientY: 750, detail: 1 })
    })

    const minimizedLift = appliedTranslate(screen.getByTestId("incoming-call-overlay")).y
    expect(minimizedLift).toBeGreaterThan(expandedLift)
    expect(overlapsSquare()).toBe(false)
    expect(screen.getByLabelText("Restore call")).toBeInTheDocument()

    act(() => {
      fireEvent.click(screen.getByLabelText("Restore call"))
    })
    expect(overlapsSquare()).toBe(false)
  })

  it("clears the square with several stacked ring cards", () => {
    renderBothSurfaces()
    enterConnected()
    act(() => {
      addIncomingCall(makeRing())
      addIncomingCall(makeRing({ attemptId: "callinv_2", callId: "call_2", inviterName: "Bo" }))
      addIncomingCall(makeRing({ attemptId: "callinv_3", callId: "call_3", inviterName: "Cy" }))
    })

    expect(screen.getAllByRole("alert")).toHaveLength(3)
    expect(overlapsSquare()).toBe(false)
    expect(fullyOnScreen()).toBe(true)
  })

  it("re-resolves on viewport resize and keeps the ring on-screen", () => {
    renderBothSurfaces()
    enterConnected()
    act(() => addIncomingCall(makeRing()))

    act(() => {
      setViewport(500, 400)
      window.dispatchEvent(new Event("resize"))
    })

    expect(fullyOnScreen()).toBe(true)

    act(() => {
      setViewport(1440, 900)
      window.dispatchEvent(new Event("resize"))
    })

    expect(overlapsSquare()).toBe(false)
    expect(fullyOnScreen()).toBe(true)
  })

  it("returns the ring to its anchor when the floating square unmounts", () => {
    const view = renderBothSurfaces()
    enterConnected()
    act(() => addIncomingCall(makeRing()))
    expect(screen.getByTestId("incoming-call-overlay").style.transform).not.toBe("")

    act(() => {
      view.rerender(
        <MemoryRouter>
          <CallManagerProvider manager={makeManager()}>
            <CallLaunchProvider>
              <IncomingCallOverlay workspaceId={WORKSPACE_ID} />
            </CallLaunchProvider>
          </CallManagerProvider>
        </MemoryRouter>
      )
    })

    expect(screen.getByTestId("incoming-call-overlay").style.transform).toBe("")
  })
  it("publishes the connected surface's measured control groups, and clears them", () => {
    renderBothSurfaces()
    enterConnected()
    act(() => addIncomingCall(makeRing()))

    // Two groups, measured — not a guessed band: the whole header (its grip and
    // title drag the square, so the marked region spans the surface's full width,
    // not just the action pair) and the controls row.
    const [header, controls] = protectedRects()
    expect(header).toMatchObject({ x: squareRect().x, y: squareRect().y, width: squareRect().width })
    expect(controls!.width).toBeLessThan(squareRect().width)
    for (const region of protectedRects()) expect(overlapsRect(region)).toBe(false)
  })

  it("re-avoids when only the phase body changes — the joining gate's controls sit mid-surface", async () => {
    setViewport(800, 700)
    // Never settles: the launch parks in `requesting`, so the PreJoinGate swap is
    // purely a child's state change — FloatingCallSquare itself does not rerender,
    // and only the observed republish can move the ring.
    renderBothSurfaces(makeManager({ startCall: vi.fn(() => new Promise<void>(() => {})) }))
    dragSquareTo(206, 224)
    act(() => {
      for (let i = 0; i < 3; i++) {
        addIncomingCall(makeRing({ attemptId: `callinv_${i}`, callId: `call_${i}` }))
      }
    })

    // Launch idle: the body is a "Connecting…" label with nothing to hit, so only
    // the header is protected — and the ring settles across where the gate is
    // about to appear.
    expect(screen.getByText("Connecting…")).toBeInTheDocument()
    expect(protectedRects()).toHaveLength(1)
    const settled = ringRect()

    act(() => {
      fireEvent.click(screen.getByText("launch"))
    })
    expect(screen.getByText("Joining…")).toBeInTheDocument()

    // One microtask turn — the observer's own scheduling, not an incidental rerender.
    await act(async () => {})
    expect(protectedRects()).toHaveLength(2)
    // The gate's arrival alone moved the ring; nothing rerendered the square.
    expect(ringRect()).not.toEqual(settled)
    // Every measured group, the header included — not just the gate that
    // triggered the republish.
    for (const region of protectedRects()) expect(overlapsRect(region)).toBe(false)
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
    expect(fullyOnScreen()).toBe(true)
  })

  it("republishes when the surface's subtree changes without a rerender of its own", async () => {
    renderBothSurfaces()
    enterConnected()
    act(() => addIncomingCall(makeRing()))
    expect(protectedRects()).toHaveLength(2)

    // The phase body owns its own state, so a swap there can land without
    // rerendering the square: mutate the subtree directly and require the
    // observer, not a render, to republish.
    act(() => {
      screen.getByLabelText("Leave call").closest("[data-call-surface-protected]")?.remove()
    })

    // One microtask turn — the observer's own scheduling. A later incidental
    // rerender would republish too, so the assertion is deliberately prompt.
    await act(async () => {})
    expect(protectedRects()).toHaveLength(1)
  })

  it("yields stacking to the floating surface when no placement can clear its controls", () => {
    // 400x400 with the expanded square in its clamped home and four stacked ring
    // cards: every on-screen placement lies across the header's drag surface, so
    // geometry has run out. The ring drops below the z-50 surface rather than
    // taking its clicks.
    setViewport(400, 400)
    renderBothSurfaces()
    enterConnected()
    act(() => {
      for (let i = 0; i < 4; i++) addIncomingCall(makeRing({ attemptId: `callinv_${i}`, callId: `call_${i}` }))
    })

    const overlay = screen.getByTestId("incoming-call-overlay")
    expect(protectedRects().some((region) => overlapsRect(region))).toBe(true)
    expect(overlay.className).toContain("z-[49]")
    expect(overlay.className).not.toContain("z-50")
    expect(screen.getByTestId("floating-call-square").className).toContain("z-50")
    expect(fullyOnScreen()).toBe(true)
    expect(screen.getByLabelText("Leave call")).toBeInTheDocument()
    expect(screen.getByTestId("floating-call-square-header")).toBeInTheDocument()
    const acceptButtons = screen.getAllByLabelText("Accept call")
    expect(acceptButtons).toHaveLength(4)
    for (const button of acceptButtons) expect(button.parentElement).toHaveAttribute("inert")

    act(() => {
      setViewport(1440, 900)
      window.dispatchEvent(new Event("resize"))
    })
    expect(protectedRects().some((region) => overlapsRect(region))).toBe(false)
    expect(screen.getByTestId("incoming-call-overlay").className).toContain("z-50")
    for (const button of acceptButtons) expect(button.parentElement).not.toHaveAttribute("inert")
  })
})
