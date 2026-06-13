import { describe, it, expect, vi } from "vitest"
import { SETTINGS_TABS, SIDEBAR_QUICK_LINKS, type SidebarQuickLinkKey } from "@threa/types"
import { commands, type Command, type CommandContext } from "./commands"

describe("commands", () => {
  it("should have at least one command defined", () => {
    expect(commands.length).toBeGreaterThan(0)
  })

  it("should have unique command IDs", () => {
    const ids = commands.map((c) => c.id)
    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(ids.length)
  })

  describe.each(commands)("command: $id", (command: Command) => {
    it("should have a non-empty id", () => {
      expect(command.id).toBeTruthy()
      expect(typeof command.id).toBe("string")
    })

    it("should have a non-empty label", () => {
      expect(command.label).toBeTruthy()
      expect(typeof command.label).toBe("string")
    })

    it("should have an icon component", () => {
      expect(command.icon).toBeDefined()
      // Lucide icons are forwardRef objects with $$typeof symbol
      expect(command.icon).toHaveProperty("$$typeof")
    })

    it("should have an action function", () => {
      expect(command.action).toBeDefined()
      expect(typeof command.action).toBe("function")
    })

    it("should have keywords as an array if defined", () => {
      if (command.keywords !== undefined) {
        expect(Array.isArray(command.keywords)).toBe(true)
        command.keywords.forEach((keyword) => {
          expect(typeof keyword).toBe("string")
        })
      }
    })
  })

  describe("specific commands", () => {
    it("should include new-scratchpad command", () => {
      const cmd = commands.find((c) => c.id === "new-scratchpad")
      expect(cmd).toBeDefined()
      expect(cmd?.label).toBe("New Scratchpad")
    })

    it("should include new-channel command", () => {
      const cmd = commands.find((c) => c.id === "new-channel")
      expect(cmd).toBeDefined()
      expect(cmd?.label).toBe("New Channel")
    })

    it("should include search command", () => {
      const cmd = commands.find((c) => c.id === "search")
      expect(cmd).toBeDefined()
      expect(cmd?.label).toBe("Search messages")
    })

    it("should include memory command", () => {
      const cmd = commands.find((c) => c.id === "open-memory")
      expect(cmd).toBeDefined()
      expect(cmd?.label).toBe("Open Memory")
      expect(cmd?.keywords).toEqual(expect.arrayContaining(["memo", "memos", "knowledge"]))
    })
  })

  // Every standing view in the sidebar's Quick Links block must also be
  // reachable from the palette, so the two never drift. Most links navigate to
  // `/w/:workspaceId/<key>`; `files` is special — it opens the attachment
  // explorer (the same ExplorerShell the /files page renders) rather than
  // routing to the page.
  describe("sidebar quick-link parity", () => {
    const WORKSPACE_ID = "workspace_test"

    function makeContext() {
      const navigate = vi.fn()
      const openExplorer = vi.fn()
      const context = {
        workspaceId: WORKSPACE_ID,
        navigate,
        closeDialog: vi.fn(),
        createDraftScratchpad: vi.fn(async () => "draft_x"),
        createEncryptedScratchpad: vi.fn(async () => "stream_x"),
        openCreateChannel: vi.fn(),
        setMode: vi.fn(),
        openSearch: vi.fn(),
        requestInput: vi.fn(),
        openSettings: vi.fn(),
        openWorkspaceSettings: vi.fn(),
        openExplorer,
        openStreamSettings: vi.fn(),
        requestArchiveStream: vi.fn(),
        openLabelPicker: vi.fn(),
        createSavedTodo: vi.fn(async () => {}),
      } as unknown as CommandContext
      return { context, navigate, openExplorer }
    }

    /** The palette destination each sidebar quick link must be reachable through. */
    const reachability: Record<SidebarQuickLinkKey, (ctx: ReturnType<typeof makeContext>) => void> = {
      drafts: ({ navigate }) => expect(navigate).toHaveBeenCalledWith(`/w/${WORKSPACE_ID}/drafts`),
      saved: ({ navigate }) => expect(navigate).toHaveBeenCalledWith(`/w/${WORKSPACE_ID}/saved`),
      files: ({ openExplorer }) => expect(openExplorer).toHaveBeenCalled(),
      scheduled: ({ navigate }) => expect(navigate).toHaveBeenCalledWith(`/w/${WORKSPACE_ID}/scheduled`),
      memory: ({ navigate }) => expect(navigate).toHaveBeenCalledWith(`/w/${WORKSPACE_ID}/memory`),
      labels: ({ navigate }) => expect(navigate).toHaveBeenCalledWith(`/w/${WORKSPACE_ID}/labels`),
      activity: ({ navigate }) => expect(navigate).toHaveBeenCalledWith(`/w/${WORKSPACE_ID}/activity`),
    }

    it.each(SIDEBAR_QUICK_LINKS)("exposes a palette command that reaches the %s quick link", (key) => {
      // Run every command's action and assert the key's destination was hit by
      // at least one of them.
      const harness = makeContext()
      for (const command of commands) {
        command.action(harness.context)
      }
      reachability[key](harness)
    })
  })

  // "Add To-do" switches the palette into its inline input mode and saves the
  // typed title as a standalone saved item.
  describe("add-todo", () => {
    function runAddTodo() {
      const cmd = commands.find((c) => c.id === "add-todo")!
      const requestInput = vi.fn()
      const closeDialog = vi.fn()
      const createSavedTodo = vi.fn(async () => {})
      cmd.action({ requestInput, closeDialog, createSavedTodo } as unknown as CommandContext)
      const request = requestInput.mock.calls[0]![0] as {
        placeholder: string
        hint: string
        onSubmit: (value: string) => Promise<void>
      }
      return { request, closeDialog, createSavedTodo }
    }

    it("requests inline input rather than acting immediately", () => {
      const { request, closeDialog, createSavedTodo } = runAddTodo()
      expect(request.placeholder).toBeTruthy()
      expect(request.hint).toBeTruthy()
      expect(createSavedTodo).not.toHaveBeenCalled()
      expect(closeDialog).not.toHaveBeenCalled()
    })

    it("creates the saved item with the trimmed title and closes the palette", async () => {
      const { request, closeDialog, createSavedTodo } = runAddTodo()
      await request.onSubmit("  Call the landlord  ")
      expect(createSavedTodo).toHaveBeenCalledWith("Call the landlord")
      expect(closeDialog).toHaveBeenCalled()
    })

    it("ignores empty submissions", async () => {
      const { request, closeDialog, createSavedTodo } = runAddTodo()
      await request.onSubmit("   ")
      expect(createSavedTodo).not.toHaveBeenCalled()
      expect(closeDialog).not.toHaveBeenCalled()
    })

    it("keeps the palette open when the create fails", async () => {
      const cmd = commands.find((c) => c.id === "add-todo")!
      const requestInput = vi.fn()
      const closeDialog = vi.fn()
      const createSavedTodo = vi.fn(async () => {
        throw new Error("offline")
      })
      cmd.action({ requestInput, closeDialog, createSavedTodo } as unknown as CommandContext)
      const request = requestInput.mock.calls[0]![0] as { onSubmit: (value: string) => Promise<void> }

      await request.onSubmit("Buy milk")

      expect(createSavedTodo).toHaveBeenCalled()
      expect(closeDialog).not.toHaveBeenCalled()
    })
  })

  // Settings tabs must each be reachable directly from the palette — typing
  // "notifications" or "keyboard" should land on the right tab without
  // knowing it lives inside the Settings dialog.
  describe("settings discoverability", () => {
    it.each(SETTINGS_TABS)("exposes a palette command that opens the %s settings tab", (tab) => {
      const cmd = commands.find((c) => c.id === `settings-${tab}`)
      expect(cmd).toBeDefined()

      const openSettings = vi.fn()
      const closeDialog = vi.fn()
      cmd!.action({ openSettings, closeDialog } as unknown as CommandContext)

      expect(closeDialog).toHaveBeenCalled()
      expect(openSettings).toHaveBeenCalledWith(tab)
    })

    it("reaches workspace settings and member invites from the palette", () => {
      const openWorkspaceSettings = vi.fn()
      const closeDialog = vi.fn()
      const context = { openWorkspaceSettings, closeDialog } as unknown as CommandContext

      commands.find((c) => c.id === "open-workspace-settings")!.action(context)
      expect(openWorkspaceSettings).toHaveBeenCalledWith("general")

      commands.find((c) => c.id === "invite-people")!.action(context)
      expect(openWorkspaceSettings).toHaveBeenCalledWith("users")
    })
  })
})
