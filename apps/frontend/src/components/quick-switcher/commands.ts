import type { NavigateFunction } from "react-router-dom"
import {
  Bell,
  Bookmark,
  Brain,
  CalendarClock,
  Columns3,
  FileText,
  Hash,
  Paperclip,
  Search,
  FileEdit,
  Lock,
  Settings,
  StickyNote,
  Tag,
  UserPlus,
} from "lucide-react"
import { toast } from "sonner"
import { SETTINGS_TABS, type SettingsTab } from "@threa/types"
import { SETTINGS_TAB_CONFIG } from "@/components/settings/tab-config"
import type { WorkspaceSettingsTab } from "@/components/workspace-settings/tab-config"
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
   * `e2e_streams` row can be written atomically with the stream insert
   * (INV-7). Returns the new stream id; throws/toasts if the user's E2E
   * session isn't unlocked. `withAriadne` invites the enclave actor so the
   * scratchpad gets AI replies; pass false for a no-AI encrypted quick note.
   */
  createEncryptedScratchpad: (withAriadne: boolean) => Promise<string>
  openCreateChannel: () => void
  setMode?: (mode: "stream" | "command" | "search") => void
  requestInput: (request: InputRequest) => void
  openSettings: (tab?: SettingsTab) => void
  /** Open the workspace settings dialog at a tab (URL-param driven, like openSettings). */
  openWorkspaceSettings: (tab: WorkspaceSettingsTab) => void
  openExplorer: (overrides?: Partial<ExplorerFilters>) => void
  /**
   * The stream currently in view (route param), or null on non-stream routes.
   * Contextual stream commands (archive, settings, files, labels) read this to
   * know what they act on; they are only surfaced when it is set.
   */
  currentStreamId?: string | null
  /** Resolved display name of `currentStreamId`, for section headers/confirm copy. */
  currentStreamName?: string | null
  /** Open the stream settings dialog for a stream. */
  openStreamSettings: (streamId: string) => void
  /** Open the destructive confirmation for archiving (or deleting a draft) a stream. */
  requestArchiveStream: (streamId: string) => void
  /** Open the label picker for a stream. */
  openLabelPicker: (streamId: string) => void
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
    id: "new-quick-note",
    label: "New Quick Note",
    icon: StickyNote,
    keywords: [
      "scratchpad",
      "plain",
      "pure",
      "dump",
      "link",
      "links",
      "bookmark",
      "no companion",
      "no ai",
      "silent",
      "quiet",
      "note",
      "capture",
    ],
    action: async ({ workspaceId, navigate, closeDialog, createDraftScratchpad }) => {
      try {
        const draftId = await createDraftScratchpad("off")
        closeDialog()
        navigate(`/w/${workspaceId}/s/${draftId}`)
      } catch (error) {
        console.error("Failed to create quick note:", error)
        toast.error("Failed to create quick note")
      }
    },
  },
  {
    id: "new-encrypted-scratchpad",
    label: "New Encrypted Scratchpad",
    icon: Lock,
    keywords: ["create", "encrypted", "e2e", "private", "secret", "secure", "ariadne", "ai"],
    action: async ({ workspaceId, navigate, closeDialog, createEncryptedScratchpad }) => {
      try {
        const streamId = await createEncryptedScratchpad(true)
        closeDialog()
        navigate(`/w/${workspaceId}/s/${streamId}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to create encrypted scratchpad"
        toast.error(message)
      }
    },
  },
  {
    id: "new-encrypted-quick-note",
    label: "New Encrypted Quick Note",
    icon: Lock,
    keywords: ["create", "encrypted", "e2e", "private", "secret", "secure", "no ai", "no companion", "quiet", "silent"],
    action: async ({ workspaceId, navigate, closeDialog, createEncryptedScratchpad }) => {
      try {
        const streamId = await createEncryptedScratchpad(false)
        closeDialog()
        navigate(`/w/${workspaceId}/s/${streamId}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to create encrypted quick note"
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
  // Destination commands mirror the sidebar's Quick Links block (drafts, saved,
  // files, scheduled, memory, labels, activity) so every standing view is
  // reachable from the palette, in the same order.
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
    id: "view-saved",
    label: "View Saved",
    icon: Bookmark,
    keywords: ["bookmark", "bookmarks", "starred", "later", "read later"],
    action: ({ workspaceId, navigate, closeDialog }) => {
      closeDialog()
      navigate(`/w/${workspaceId}/saved`)
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
    id: "view-scheduled",
    label: "View Scheduled",
    icon: CalendarClock,
    keywords: ["schedule", "later", "send later", "queued", "upcoming"],
    action: ({ workspaceId, navigate, closeDialog }) => {
      closeDialog()
      navigate(`/w/${workspaceId}/scheduled`)
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
    id: "view-labels",
    label: "View Labels",
    icon: Tag,
    keywords: ["tag", "tags", "categories", "organize"],
    action: ({ workspaceId, navigate, closeDialog }) => {
      closeDialog()
      navigate(`/w/${workspaceId}/labels`)
    },
  },
  {
    id: "view-activity",
    label: "View Activity",
    icon: Bell,
    keywords: ["notifications", "feed", "mentions", "updates", "inbox"],
    action: ({ workspaceId, navigate, closeDialog }) => {
      closeDialog()
      navigate(`/w/${workspaceId}/activity`)
    },
  },
  {
    id: "equalize-panes",
    label: "Equalize Panes",
    icon: Columns3,
    keywords: ["split", "panels", "panes", "resize", "layout", "equal", "distribute"],
    action: ({ closeDialog }) => {
      closeDialog()
      // Handled by WorkspacePanelArea — same DOM-event pattern as
      // "threa:open-stream-search".
      document.dispatchEvent(new CustomEvent("threa:equalize-panes"))
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
  // One palette entry per user-settings tab, so typing "notifications",
  // "keyboard", or "timezone" finds the right surface without knowing it
  // lives inside the Settings dialog.
  ...SETTINGS_TABS.map((tab): Command => {
    const config = SETTINGS_TAB_CONFIG[tab]
    return {
      id: `settings-${tab}`,
      label: `Settings: ${config.label}`,
      icon: Settings,
      keywords: ["preferences", ...config.keywords],
      action: ({ closeDialog, openSettings }) => {
        closeDialog()
        openSettings(tab)
      },
    }
  }),
  {
    id: "open-workspace-settings",
    label: "Workspace Settings",
    icon: Settings,
    keywords: ["admin", "members", "bots", "api keys", "integrations", "statuses"],
    action: ({ closeDialog, openWorkspaceSettings }) => {
      closeDialog()
      openWorkspaceSettings("general")
    },
  },
  {
    id: "invite-people",
    label: "Invite People",
    icon: UserPlus,
    keywords: ["invitation", "add member", "teammate", "team", "share workspace"],
    action: ({ closeDialog, openWorkspaceSettings }) => {
      closeDialog()
      openWorkspaceSettings("users")
    },
  },
]
