import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, userEvent } from "@/test"
import { StreamTypes } from "@threa/types"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as inputModeModule from "@/hooks/use-input-mode"
import { createMockStream } from "@/test/fixtures"
import { StreamTargetPicker } from "./stream-target-picker"
import { NEW_SCRATCHPAD } from "@/lib/board-post-target"

const general = createMockStream({
  id: "stream_c1",
  type: StreamTypes.CHANNEL,
  displayName: "General",
  slug: "general",
})
const dm = createMockStream({ id: "stream_d1", type: StreamTypes.DM, displayName: "Martin" })
const streams = [general, dm]

beforeEach(() => {
  Element.prototype.scrollIntoView ??= () => {}
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.setPointerCapture ??= () => {}
  vi.spyOn(inputModeModule, "useInputMode").mockReturnValue("mouse")
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue(streams as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreamMemberships").mockReturnValue(
    streams.map((s) => ({ streamId: s.id })) as never
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceUnreadState").mockReturnValue(undefined as never)
})

describe("StreamTargetPicker", () => {
  it("shows the placeholder when no target is chosen", () => {
    render(<StreamTargetPicker workspaceId="workspace_1" value="" onChange={vi.fn()} includeNewOptions />)
    expect(screen.getByRole("combobox")).toHaveTextContent("Post to…")
  })

  it("shows the selected stream's name on the trigger", () => {
    render(<StreamTargetPicker workspaceId="workspace_1" value="stream_c1" onChange={vi.fn()} />)
    expect(screen.getByRole("combobox")).toHaveTextContent("general")
  })

  it("opens to the New options + channel group and selects a target", async () => {
    const onChange = vi.fn()
    render(<StreamTargetPicker workspaceId="workspace_1" value="" onChange={onChange} includeNewOptions />)

    await userEvent.click(screen.getByRole("combobox"))

    expect(await screen.findByText("New scratchpad")).toBeInTheDocument()
    expect(screen.getByText("New quick note")).toBeInTheDocument()
    expect(screen.getByText("Channels")).toBeInTheDocument()

    await userEvent.click(screen.getByText("New scratchpad"))
    expect(onChange).toHaveBeenCalledWith(NEW_SCRATCHPAD)
  })

  it("hides the New options when includeNewOptions is off", async () => {
    render(<StreamTargetPicker workspaceId="workspace_1" value="" onChange={vi.fn()} />)
    await userEvent.click(screen.getByRole("combobox"))
    expect(await screen.findByText("Channels")).toBeInTheDocument()
    expect(screen.queryByText("New scratchpad")).not.toBeInTheDocument()
  })
})
