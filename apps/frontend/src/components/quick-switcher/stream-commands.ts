import { Archive, FileCode2, ListChecks, Paperclip, Settings, Tag, Trash2 } from "lucide-react"
import { queueSnippetRequest } from "@/stores/snippet-request-store"
import type { Command } from "./commands"

/**
 * Open the snippet editor in the current stream's composer. The composer lives
 * in a separate React tree, so the request is handed off through the
 * snippet-request store (consumed in `message-input`). Shared by real streams
 * and draft scratchpads — both have a composer to attach to.
 */
const createSnippetCommand: Command = {
  id: "stream-create-snippet",
  label: "Create snippet",
  icon: FileCode2,
  keywords: ["snippet", "code", "paste", "attach", "text", "file", "current stream"],
  action: ({ currentStreamId, closeDialog }) => {
    if (!currentStreamId) return
    closeDialog()
    queueSnippetRequest(currentStreamId)
  },
}

/**
 * Commands that act on the stream currently in view. `use-command-items` only
 * surfaces these when `CommandContext.currentStreamId` is set, so the guard in
 * each action is belt-and-suspenders. Archive is destructive, so it sits last
 * to keep it away from the default-focused top of the palette where users could
 * trigger it by accident. Real streams archive (reversible); draft scratchpads
 * are deleted via `draftStreamCommands` instead.
 */
export const streamCommands: Command[] = [
  createSnippetCommand,
  {
    id: "stream-settings",
    label: "Open stream settings",
    icon: Settings,
    keywords: ["configure", "rename", "notifications", "preferences", "current stream"],
    action: ({ currentStreamId, openStreamSettings }) => {
      if (!currentStreamId) return
      openStreamSettings(currentStreamId)
    },
  },
  {
    id: "stream-files",
    label: "Browse files in this stream",
    icon: Paperclip,
    keywords: ["attachments", "uploads", "media", "explorer", "current stream"],
    action: ({ currentStreamId, openExplorer, closeDialog }) => {
      if (!currentStreamId) return
      closeDialog()
      openExplorer({ streamIds: [currentStreamId] })
    },
  },
  {
    id: "stream-agenda",
    label: "Agent agenda in this stream",
    icon: ListChecks,
    keywords: ["follow-up", "follow ups", "delegation", "delegated", "agent", "current stream"],
    action: ({ currentStreamId, openOutcomes, closeDialog }) => {
      if (!currentStreamId) return
      closeDialog()
      openOutcomes({ streamIds: [currentStreamId] })
    },
  },
  {
    id: "stream-labels",
    label: "Labels…",
    icon: Tag,
    keywords: ["tag", "categorize", "organize", "current stream"],
    action: ({ currentStreamId, openLabelPicker }) => {
      if (!currentStreamId) return
      openLabelPicker(currentStreamId)
    },
  },
  {
    id: "stream-archive",
    label: "Archive this stream",
    icon: Archive,
    keywords: ["hide", "remove", "close", "current stream"],
    action: ({ currentStreamId, requestArchiveStream }) => {
      if (!currentStreamId) return
      requestArchiveStream(currentStreamId)
    },
  },
]

/** Draft scratchpads have no server-side settings/files/labels — only snippet
 *  creation (the draft has a composer) and deletion. */
export const draftStreamCommands: Command[] = [
  createSnippetCommand,
  {
    id: "stream-delete-draft",
    label: "Delete this draft",
    icon: Trash2,
    keywords: ["remove", "discard", "trash", "current stream"],
    action: ({ currentStreamId, requestArchiveStream }) => {
      if (!currentStreamId) return
      requestArchiveStream(currentStreamId)
    },
  },
]
