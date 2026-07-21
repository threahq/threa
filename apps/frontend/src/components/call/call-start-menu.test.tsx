import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act } from "@testing-library/react"
import { render, screen, userEvent } from "@/test"
import { clearCallState, setCallSession, setCallPhase } from "@/stores/call-store"
import type { CallController } from "@/calls/call-manager"
import { CallStartMenu } from "./call-start-menu"
import { CallManagerProvider } from "./call-manager-context"
import { CallLaunchProvider } from "./call-launch-context"

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

function renderMenu(manager: CallController) {
  return render(
    <CallManagerProvider manager={manager}>
      <CallLaunchProvider>
        <CallStartMenu workspaceId="ws_1" streamId="stream_1" />
      </CallLaunchProvider>
    </CallManagerProvider>
  )
}

beforeEach(() => clearCallState())
afterEach(() => vi.restoreAllMocks())

describe("CallStartMenu", () => {
  it("starts a mic-only call on 'Start voice call'", async () => {
    const manager = makeManager()
    renderMenu(manager)
    await userEvent.click(screen.getByRole("button", { name: "Start call" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Start voice call" }))
    expect(manager.startCall).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws_1", streamId: "stream_1", mode: "video", cameraOn: false })
    )
  })

  it("starts with the camera on 'Start video call'", async () => {
    const manager = makeManager()
    renderMenu(manager)
    await userEvent.click(screen.getByRole("button", { name: "Start call" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Start video call" }))
    expect(manager.startCall).toHaveBeenCalledWith(expect.objectContaining({ cameraOn: true }))
  })

  it("disables the trigger while a call is already active (no second start)", () => {
    renderMenu(makeManager())
    // Idle → enabled.
    expect(screen.getByRole("button", { name: "Start call" })).not.toBeDisabled()
    // A live call → the trigger disables, so a second concurrent start can't launch.
    act(() => {
      setCallSession({ callId: "call_1", workspaceId: "ws_1", streamId: "stream_1", mode: "video" })
      setCallPhase("connected")
    })
    expect(screen.getByRole("button", { name: "You're already in a call" })).toBeDisabled()
  })
})
