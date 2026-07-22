import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { render, screen, userEvent } from "@/test"
import * as useMobileModule from "@/hooks/use-mobile"
import { clearCallState, setCallSession, setCallPhase, setCallDevices, type CallDeviceState } from "@/stores/call-store"
import type { CallController } from "@/calls/call-manager"
import { CallControls, DevicePickerMenu } from "./call-controls"
import { CallManagerProvider } from "./call-manager-context"

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
