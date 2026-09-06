import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { fireEvent, render, screen, userEvent } from "@/test"
import { StreamTypes } from "@threahq/types"
import * as useMobileModule from "@/hooks/use-mobile"
import * as workspaceStore from "@/stores/workspace-store"
import * as sonner from "sonner"
import { clearCallLifecycleLog, recordCallLifecycleEvent } from "@/calls/lifecycle-log"
import {
  clearCallState,
  getCallState,
  setCallSession,
  setCallPhase,
  setCallDevices,
  setCallSurfaceMode,
  setDesktopSurfaceOverride,
  type CallDeviceState,
} from "@/stores/call-store"
import type { CallController } from "@/calls/call-manager"
import {
  __resetCallPrefsForTests,
  getCallPrefs,
  setDesktopCallSurface,
  setLastDesktopSurface,
} from "@/stores/call-prefs-store"
import { CallControls, DevicePickerMenu } from "./call-controls"
import { CallManagerProvider } from "./call-manager-context"

// The store's own row type, reached through the hook so this component test does
// not import `@/db` (INV-15).
type CachedWorkspaceStream = ReturnType<typeof workspaceStore.useWorkspaceStreamsRaw>[number]

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

function device(deviceId: string, label: string, kind: MediaDeviceKind): MediaDeviceInfo {
  return { deviceId, label, kind, groupId: "grp", toJSON: () => ({}) } as MediaDeviceInfo
}

function makeDevices(overrides: Partial<CallDeviceState> = {}): CallDeviceState {
  return {
    inputs: [],
    outputs: [],
    cameras: [],
    selectedInputId: null,
    selectedOutputId: null,
    selectedCameraId: null,
    facingMode: null,
    ...overrides,
  }
}

function renderPicker(manager: CallController, devices: CallDeviceState) {
  return render(
    <CallManagerProvider manager={manager}>
      <DevicePickerMenu devices={devices} />
    </CallManagerProvider>
  )
}

function renderControls(manager: CallController) {
  return render(
    <CallManagerProvider manager={manager}>
      <CallControls />
    </CallManagerProvider>
  )
}

function enterVideoCall(overrides: Partial<CallDeviceState> = {}) {
  act(() => {
    setCallSession({ callId: "call_1", workspaceId: "ws_1", streamId: "stream_1", mode: "video" })
    setCallPhase("connected")
    setCallDevices(makeDevices(overrides))
  })
}

beforeEach(() => {
  clearCallState()
  localStorage.clear()
  __resetCallPrefsForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("DevicePickerMenu — camera group", () => {
  it("renders the camera group and switches camera on select", async () => {
    const manager = makeManager()
    renderPicker(
      manager,
      makeDevices({
        cameras: [device("cam-front", "Front camera", "videoinput"), device("cam-back", "Back camera", "videoinput")],
        selectedCameraId: "cam-front",
      })
    )

    await userEvent.click(screen.getByLabelText("Devices"))
    expect(await screen.findByText("Camera")).toBeInTheDocument()
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "Back camera" }))

    expect(manager.switchCameraDevice).toHaveBeenCalledWith("cam-back")
  })

  it("labels unlabeled cameras with a Camera N fallback", async () => {
    renderPicker(
      makeManager(),
      makeDevices({ cameras: [device("c1", "", "videoinput"), device("c2", "", "videoinput")] })
    )

    await userEvent.click(screen.getByLabelText("Devices"))
    expect(await screen.findByRole("menuitemradio", { name: "Camera 1" })).toBeInTheDocument()
    expect(screen.getByRole("menuitemradio", { name: "Camera 2" })).toBeInTheDocument()
  })

  it("omits the camera group when there are no cameras", async () => {
    renderPicker(makeManager(), makeDevices({ inputs: [device("m1", "Mic 1", "audioinput")] }))

    await userEvent.click(screen.getByLabelText("Devices"))
    expect(await screen.findByText("Microphone")).toBeInTheDocument()
    expect(screen.queryByText("Camera")).toBeNull()
  })

  it("hides the camera group on mobile even with cameras (flip is the only camera control there)", async () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
    renderPicker(
      makeManager(),
      makeDevices({
        cameras: [device("cam-front", "Front camera", "videoinput"), device("cam-back", "Back camera", "videoinput")],
        inputs: [device("m1", "Mic 1", "audioinput")],
      })
    )

    await userEvent.click(screen.getByLabelText("Devices"))
    expect(await screen.findByText("Microphone")).toBeInTheDocument()
    expect(screen.queryByText("Camera")).toBeNull()
  })
})

describe("CallControls — call chat", () => {
  function renderRouted(manager: CallController) {
    return render(
      <MemoryRouter initialEntries={["/w/ws_1/s/other"]}>
        <CallManagerProvider manager={manager}>
          <CallControls />
        </CallManagerProvider>
      </MemoryRouter>
    )
  }

  it("opens the call chat thread on the call_started anchor of the call's stream", () => {
    act(() => {
      setCallSession({
        callId: "call_1",
        workspaceId: "ws_1",
        streamId: "stream_1",
        mode: "video",
        chatAnchorId: "event_chat_1",
      })
      setCallPhase("connected")
    })
    renderRouted(makeManager())
    const chat = screen.getByRole("link", { name: "Open call chat" })
    const href = chat.getAttribute("href") ?? ""
    // Absolute host-stream URL (dock is above PanelProvider) + draft panel keyed
    // on the call_started event id.
    expect(href).toContain("/w/ws_1/s/stream_1")
    expect(href).toContain("draft%3Astream_1%3Aevent_chat_1")
  })

  it("targets the real thread once the chat thread exists, so no draft flashes first", () => {
    vi.spyOn(workspaceStore, "useWorkspaceStreamsRaw").mockReturnValue([
      {
        id: "stream_chat_thread",
        workspaceId: "ws_1",
        type: StreamTypes.THREAD,
        parentStreamId: "stream_1",
        parentAnchorId: "event_chat_1",
      } as CachedWorkspaceStream,
    ])
    act(() => {
      setCallSession({
        callId: "call_1",
        workspaceId: "ws_1",
        streamId: "stream_1",
        mode: "video",
        chatAnchorId: "event_chat_1",
      })
      setCallPhase("connected")
    })
    renderRouted(makeManager())
    const href = screen.getByRole("link", { name: "Open call chat" }).getAttribute("href") ?? ""
    expect(href).toContain("panel=stream_chat_thread")
    expect(href).not.toContain("draft")
  })

  it.each([
    ["configured fullscreen", "fullscreen", "floating"],
    ["keep-last fullscreen", "keep_last", "fullscreen"],
  ] as const)("reveals chat from %s without touching the desktop surface", (_, pref, last) => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
    setDesktopCallSurface(pref)
    setLastDesktopSurface(last)
    act(() => {
      setCallSession({
        callId: "call_1",
        workspaceId: "ws_1",
        streamId: "stream_1",
        mode: "video",
        chatAnchorId: "event_chat_1",
      })
      setCallPhase("connected")
    })
    renderRouted(makeManager())
    const chat = screen.getByRole("link", { name: "Open call chat" })
    fireEvent.click(chat)
    // The overlay leaves the panel column free (--panel-inset-right), so chat opens
    // beside the video instead of ejecting the user out of fullscreen.
    expect(chat.getAttribute("href") ?? "").toContain("draft%3Astream_1%3Aevent_chat_1")
    expect(getCallState().desktopSurfaceOverride).toBeNull()
    expect(getCallPrefs()).toMatchObject({ desktopCallSurface: pref, lastDesktopSurface: last })
  })

  it("keeps the desktop fullscreen surface when chat opens", () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
    act(() => {
      setCallSession({
        callId: "call_1",
        workspaceId: "ws_1",
        streamId: "stream_1",
        mode: "video",
        chatAnchorId: "event_chat_1",
      })
      setCallPhase("connected")
      setCallSurfaceMode("standard")
      setDesktopSurfaceOverride("fullscreen")
    })
    renderRouted(makeManager())
    fireEvent.click(screen.getByRole("link", { name: "Open call chat" }))
    expect(getCallState()).toMatchObject({ desktopSurfaceOverride: "fullscreen", surfaceMode: "standard" })
  })

  it("collapses the mobile full surface when chat opens (panel takes over the screen there)", () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
    act(() => {
      setCallSession({
        callId: "call_1",
        workspaceId: "ws_1",
        streamId: "stream_1",
        mode: "video",
        chatAnchorId: "event_chat_1",
      })
      setCallPhase("connected")
      setCallSurfaceMode("full")
    })
    renderRouted(makeManager())
    fireEvent.click(screen.getByRole("link", { name: "Open call chat" }))
    expect(getCallState().surfaceMode).toBe("standard")
  })

  it("hides the chat control until the anchor is known", () => {
    act(() => {
      setCallSession({ callId: "call_1", workspaceId: "ws_1", streamId: "stream_1", mode: "video" })
      setCallPhase("connected")
    })
    renderRouted(makeManager())
    expect(screen.queryByRole("link", { name: "Open call chat" })).toBeNull()
  })
})

describe("CallControls — mobile flip", () => {
  function forceMobile(value: boolean) {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(value)
  }

  it("shows the flip control on mobile with multiple cameras and dispatches flipCamera", async () => {
    forceMobile(true)
    const manager = makeManager()
    renderControls(manager)
    enterVideoCall({ cameras: [device("c1", "Front", "videoinput"), device("c2", "Back", "videoinput")] })

    await userEvent.click(screen.getByLabelText("Flip camera"))
    expect(manager.flipCamera).toHaveBeenCalled()
  })

  it("hides the flip control on desktop even with multiple cameras", () => {
    forceMobile(false)
    renderControls(makeManager())
    enterVideoCall({ cameras: [device("c1", "Front", "videoinput"), device("c2", "Back", "videoinput")] })

    expect(screen.queryByLabelText("Flip camera")).toBeNull()
  })

  it("hides the flip control on mobile with only one camera", () => {
    forceMobile(true)
    renderControls(makeManager())
    enterVideoCall({ cameras: [device("c1", "Front", "videoinput")] })

    expect(screen.queryByLabelText("Flip camera")).toBeNull()
  })
})

describe("ConnectionDiagnostics — lifecycle log", () => {
  beforeEach(() => {
    clearCallLifecycleLog()
  })
  afterEach(() => {
    clearCallLifecycleLog()
  })

  async function openDiagnostics() {
    renderControls(makeManager())
    enterVideoCall()
    await userEvent.click(screen.getByLabelText("Connection diagnostics"))
  }

  it("renders the recorded entries newest-first", async () => {
    act(() => {
      recordCallLifecycleEvent({ kind: "freeze" })
      recordCallLifecycleEvent({ kind: "lease_renew_failed", detail: "CALL_LEASE_SUPERSEDED" })
    })
    await openDiagnostics()

    const rows = (await screen.findByRole("list")).querySelectorAll("li")
    expect([...rows].map((li) => li.textContent?.replace(/^\d\d:\d\d:\d\d\.\d\d\d/, ""))).toEqual([
      "lease_renew_failed CALL_LEASE_SUPERSEDED",
      "freeze",
    ])
  })

  it("copies the log and confirms in place, with no toast", async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    const toastSuccess = vi.spyOn(sonner.toast, "success")
    act(() => {
      recordCallLifecycleEvent({ kind: "pagehide" })
    })
    await openDiagnostics()

    await userEvent.click(screen.getByLabelText("Copy lifecycle log"))

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("pagehide"))
    // In-place confirmation in the same footprint — never a success toast (INV-63).
    expect(await screen.findByLabelText("Copied")).toBeInTheDocument()
    expect(toastSuccess).not.toHaveBeenCalled()
  })
})

describe("CallControls — async controls disable in-flight", () => {
  it("camera toggle disables + spins in place while running, ignoring a second tap", async () => {
    let resolveToggle!: () => void
    const setCameraOn = vi.fn(() => new Promise<void>((r) => (resolveToggle = r)))
    const manager = makeManager({ setCameraOn })
    renderControls(manager)
    enterVideoCall()

    await userEvent.click(screen.getByLabelText("Turn camera on"))
    // In flight: label switches to the busy phase and the control is disabled.
    const busy = screen.getByLabelText("Switching camera…")
    expect(busy).toBeDisabled()
    expect(setCameraOn).toHaveBeenCalledTimes(1)

    // A second tap while it's running is a no-op — this is the double-tap guard.
    await userEvent.click(busy)
    expect(setCameraOn).toHaveBeenCalledTimes(1)

    // Settles → re-enabled (the fake manager doesn't flip the store, so it returns
    // to the off label, but crucially it's interactive again).
    await act(async () => resolveToggle())
    expect(screen.getByLabelText("Turn camera on")).not.toBeDisabled()
  })
})
