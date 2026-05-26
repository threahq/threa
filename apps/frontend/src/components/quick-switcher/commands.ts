import type { NavigateFunction } from "react-router-dom"
import { Brain, FileText, Hash, Paperclip, Search, FileEdit, Lock, Settings } from "lucide-react"
import { toast } from "sonner"
import type { SettingsTab } from "@threa/types"
import type { ExplorerFilters } from "@/components/attachment-explorer"

/**
 * Commands can request an input prompt via this interface.
 * The QuickSwitcher will render this generically.
 */
export interface InputRequest {
  icon: React.ComponentType<{ className?: string }>
  placeholder: string
  hint: string
  onSubmit: (value: string) => Promise<void>
}

export interface CommandContext {
  workspaceId: string
  navigate: NavigateFunction
  closeDialog: () => void
  createDraftScratchpad: (companionMode: "on" | "off") => Promise<string>
  /**
   * Create a real (server-persisted) encrypted scratchpad and return its id.
   * Drafts don't apply here — the stream must exist on the server so the
   * `e2e_scratchpads` row can be written atomically with the stream insert
   * (INV-7). Returns the new stream id; throws/toasts if the user's E2E
   * session isn't unlocked.
   */
  createEncryptedScratchpad: () => Promise<string>
  openCreateChannel: () => void
  setMode?: (mode: "stream" | "command" | "search") => void
  requestInput: (request: InputRequest) => void
  openSettings: (tab?: SettingsTab) => void
  openExplorer: (overrides?: Partial<ExplorerFilters>) => void
}

export interface Command {
  id: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  keywords?: string[]
  action: (context: CommandContext) => void | Promise<void>
}

export const commands: Command[] = [
  {
    id: "new-scratchpad",
    label: "New Scratchpad",
    icon: FileText,
    keywords: ["create", "note", "draft"],
    action: async ({ workspaceId, navigate, closeDialog, createDraftScratchpad }) => {
      try {
        const draftId = await createDraftScratchpad("on")
        closeDialog()
        navigate(`/w/${workspaceId}/s/${draftId}`)
      } catch (error) {
        console.error("Failed to create scratchpad:", error)
        toast.error("Failed to create scratchpad")
      }
    },
  },
  {
    id: "new-encrypted-scratchpad",
    label: "New Encrypted Scratchpad",
    icon: Lock,
    keywords: ["create", "encrypted", "e2e", "private", "secret", "secure"],
    action: async ({ workspaceId, navigate, closeDialog, createEncryptedScratchpad }) => {
      try {
        const streamId = await createEncryptedScratchpad()
        closeDialog()
        navigate(`/w/${workspaceId}/s/${streamId}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to create encrypted scratchpad"
        toast.error(message)
      }
    },
  },
  {
    id: "new-channel",
    label: "New Channel",
    icon: Hash,
    keywords: ["create", "add"],
    action: ({ closeDialog, openCreateChannel }) => {
      closeDialog()
      openCreateChannel()
    },
  },
  {
    id: "search",
    label: "Search messages",
    icon: Search,
    keywords: ["find", "query"],
    action: ({ setMode }) => {
      setMode?.("search")
    },
  },
  {
    id: "view-drafts",
    label: "View Drafts",
    icon: FileEdit,
    keywords: ["draft", "unsent", "pending"],
    action: ({ workspaceId, navigate, closeDialog }) => {
      closeDialog()
      navigate(`/w/${workspaceId}/drafts`)
    },
  },
  {
    id: "open-memory",
    label: "Open Memory",
    icon: Brain,
    keywords: ["knowledge", "memo", "memos", "workspace memory"],
    action: ({ workspaceId, navigate, closeDialog }) => {
      closeDialog()
      navigate(`/w/${workspaceId}/memory`)
    },
  },
  {
    id: "browse-files",
    label: "Browse files",
    icon: Paperclip,
    keywords: ["attachments", "uploads", "media", "files", "explorer"],
    action: ({ closeDialog, openExplorer }) => {
      closeDialog()
      openExplorer({ streamIds: [] })
    },
  },
  {
    id: "open-settings",
    label: "Open Settings",
    icon: Settings,
    keywords: ["preferences", "config", "options", "theme", "appearance"],
    action: ({ closeDialog, openSettings }) => {
      closeDialog()
      openSettings()
    },
  },
]
