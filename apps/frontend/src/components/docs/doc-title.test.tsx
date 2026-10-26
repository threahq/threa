import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { TitleSource } from "@threahq/types"
import { toast } from "sonner"
import * as renameModule from "@/hooks/use-rename-stream"
import * as regenerateModule from "@/hooks/use-regenerate-title"
import * as streamStoreModule from "@/stores/stream-store"
import { TooltipProvider } from "@/components/ui/tooltip"
import { DocTitle } from "./doc-title"

const WORKSPACE_ID = "ws_1"
const DOC_ID = "stream_doc"

describe("DocTitle", () => {
  let rename: ReturnType<typeof vi.fn<(name: string) => Promise<void>>>
  let regenerate: ReturnType<typeof vi.fn<() => Promise<void>>>
  let onSubmit: ReturnType<typeof vi.fn<() => void>>

  function withStream(displayName: string | null, displayNameSource: TitleSource | null = null) {
    vi.spyOn(streamStoreModule, "useStreamFromStore").mockReturnValue({
      displayName,
      displayNameSource,
    } as unknown as ReturnType<typeof streamStoreModule.useStreamFromStore>)
  }

  beforeEach(() => {
    rename = vi.fn<(name: string) => Promise<void>>().mockResolvedValue(undefined)
    regenerate = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    onSubmit = vi.fn<() => void>()
    vi.spyOn(renameModule, "useRenameStream").mockImplementation(() => ({
      rename,
      canRename: true,
      isPending: false,
      error: null,
    }))
    vi.spyOn(regenerateModule, "useRegenerateTitle").mockReturnValue({ regenerate, isPending: false, error: null })
    withStream(null)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  function renderTitle(canWrite = true) {
    return render(
      <TooltipProvider>
        <DocTitle workspaceId={WORKSPACE_ID} docId={DOC_ID} canWrite={canWrite} onSubmit={onSubmit} />
      </TooltipProvider>
    )
  }

  it("should show the Untitled placeholder when the doc has no title", () => {
    renderTitle()
    expect(screen.getByRole("textbox", { name: "Doc title" })).toMatchObject({ value: "", placeholder: "Untitled" })
  })

  it("should rename and hand focus to the body when the writer presses Enter", async () => {
    renderTitle()
    await userEvent.type(screen.getByRole("textbox", { name: "Doc title" }), "  Launch plan {Enter}")
    expect({ renames: rename.mock.calls, submits: onSubmit.mock.calls.length }).toEqual({
      renames: [["Launch plan"]],
      submits: 1,
    })
  })

  it("should not rename when the title loses focus unchanged", async () => {
    withStream("Launch plan", "explicit")
    renderTitle()
    const input = screen.getByRole("textbox", { name: "Doc title" })
    await userEvent.click(input)
    await userEvent.type(input, "x{Backspace}")
    await userEvent.tab()
    expect(rename).not.toHaveBeenCalled()
  })

  it("should not rename when the writer clears the title", async () => {
    withStream("Launch plan", "explicit")
    renderTitle()
    const input = screen.getByRole("textbox", { name: "Doc title" })
    await userEvent.clear(input)
    await userEvent.tab()
    expect({ renames: rename.mock.calls, value: (input as HTMLInputElement).value }).toEqual({
      renames: [],
      value: "Launch plan",
    })
  })

  it("should restore the saved title when the writer presses Escape", async () => {
    withStream("Launch plan", "explicit")
    renderTitle()
    const input = screen.getByRole("textbox", { name: "Doc title" })
    await userEvent.type(input, " draft{Escape}")
    expect({
      renames: rename.mock.calls,
      value: (input as HTMLInputElement).value,
      focused: document.activeElement === input,
    }).toEqual({ renames: [], value: "Launch plan", focused: false })
  })

  it("should report a failed rename and keep the typed title when the server rejects it", async () => {
    const error = vi.spyOn(toast, "error").mockReturnValue("")
    rename.mockRejectedValue(new Error("nope"))
    renderTitle()
    const input = screen.getByRole("textbox", { name: "Doc title" })
    await userEvent.type(input, "Launch plan{Enter}")
    expect({ errors: error.mock.calls, value: (input as HTMLInputElement).value }).toEqual({
      errors: [["Couldn't rename the doc"]],
      value: "Launch plan",
    })
  })

  it("should render a heading and no input when the viewer cannot write", () => {
    withStream("Launch plan", "explicit")
    renderTitle(false)
    expect({
      heading: screen.getByRole("heading", { level: 1 }).textContent,
      inputs: screen.queryAllByRole("textbox"),
    }).toEqual({ heading: "Launch plan", inputs: [] })
  })

  it.each([
    ["explicit", true],
    ["legacy", true],
    ["generated", false],
  ] as const)("should offer regeneration only for a protected title when its source is %s", (source, offered) => {
    withStream("Launch plan", source)
    renderTitle()
    expect(screen.queryByRole("button", { name: "Regenerate title" }) !== null).toBe(offered)
  })

  it("should regenerate the title when the writer clicks Regenerate title", async () => {
    withStream("Launch plan", "explicit")
    renderTitle()
    await userEvent.click(screen.getByRole("button", { name: "Regenerate title" }))
    expect(regenerate).toHaveBeenCalledTimes(1)
  })

  it("should hold the title's line when the doc's stream row is not loaded yet", () => {
    vi.spyOn(streamStoreModule, "useStreamFromStore").mockReturnValue(undefined)
    renderTitle()
    expect({ inputs: screen.queryAllByRole("textbox"), headings: screen.queryAllByRole("heading") }).toEqual({
      inputs: [],
      headings: [],
    })
  })
})
