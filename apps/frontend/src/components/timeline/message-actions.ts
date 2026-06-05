import type { ComponentType } from "react"
import {
  Sparkles,
  MessageSquareReply,
  Quote,
  FileText,
  Type,
  Pencil,
  Trash2,
  History,
  Link2,
  Bookmark,
  BookmarkX,
  Bell,
  Share2,
  CornerDownRight,
} from "lucide-react"
import { toast } from "sonner"
import { stripMarkdown } from "@/lib/markdown"

/**
 * Context available to message actions.
 * Mirrors the Command pattern used in quick-switcher/commands.ts.
 */
export interface MessageActionContext {
  contentMarkdown: string
  actorType: string | null
  sessionId?: string
  /** Whether this message is the parent of the currently open thread panel */
  isThreadParent?: boolean
  /** URL for "reply in thread" */
  replyUrl: string
  /** URL for "show trace" (only for persona messages) */
  traceUrl?: string
  /** Message ID for edit/delete operations */
  messageId?: string
  /** Workspace ID for reaction API calls */
  workspaceId?: string
  /** Stream ID for constructing permalink URLs */
  streamId?: string
  /** Author's user ID */
  authorId?: string
  /** Current user's user ID */
  currentUserId?: string
  /** Whether this message has been edited */
  editedAt?: string
  /**
   * Whether this message lives in an end-to-end-encrypted stream. There is no
   * sealed-edit path (the backend rejects plaintext edits via INV-E1), so the
   * Edit affordance is hidden rather than shown-then-failing (E2EE-1).
   */
  e2eEnabled?: boolean
  /** Callback to enter edit mode */
  onEdit?: () => void
  /** Callback to open delete confirmation */
  onDelete?: () => void
  /** Callback to open edit history */
  onShowHistory?: () => void
  /** Callback to add a reaction (emoji character) */
  onReact?: (emoji: string) => void
  /** Callback to open the full emoji picker (used by mobile drawer to lift picker out) */
  onOpenFullPicker?: () => void
  /** Current reactions on this message (shortcode → userIds) for toggle logic */
  reactions?: Record<string, string[]>
  /** Callback to insert a quote reply into the composer */
  onQuoteReply?: () => void
  /** Callback to insert a partial quote reply with a user-selected snippet */
  onQuoteReplyWithSnippet?: (snippet: string) => void
  /**
   * Share-to-root fast path: queue a pointer share into the top-level non-thread
   * ancestor (channel/dm/scratchpad) and navigate there. Always preferred over
   * share-to-parent for nested-thread cases — the root is by far the more
   * useful target. Both entries appear when parent ≠ root (nested thread); a
   * one-level thread shows only this one because parent === root.
   */
  onShareToRoot?: () => void
  /** Label text for the share-to-root entry, e.g. "Share to #general" or "Share to scratchpad" */
  shareToRootLabel?: string
  /**
   * Share-to-parent fast path: queue a pointer share into the immediate parent
   * stream's composer and navigate there. Only present in nested threads where
   * the parent is itself a thread (or otherwise distinct from the root) — for
   * one-level threads parent === root, so the root entry covers it.
   */
  onShareToParent?: () => void
  /** Label text for the share-to-parent entry, e.g. "Share to ⌐ thread-name" */
  shareToParentLabel?: string
  /**
   * Open the cross-stream picker modal (`ShareMessageModal`) for this message.
   * Always visible alongside the fast-path share-to-root / share-to-parent
   * entries.
   */
  onShare?: () => void
  /** Callback to save or unsave the message */
  onToggleSave?: () => void
  /** Callback to open the reminder picker (mobile: bottom sheet) */
  onRequestReminder?: () => void
  /** Whether the message is currently saved by the viewer */
  isSaved?: boolean
  /** Callback to start a private "Discuss with Ariadne" scratchpad seeded with this thread */
  onDiscussWithAriadne?: () => void | Promise<void>
  /**
   * Callback to enter batch-select mode with this message preselected, so
   * the user can extend the selection or drop straight onto a target. The
   * stream-level "Move messages…" entry uses the same flow with no
   * preselection. Only present when the move action is reachable from this
   * surface (e.g. not on archived streams).
   */
  onMoveToThread?: () => void
  /**
   * Open the move drill-in drawer for a message that arrived in this
   * stream via a move. Set only when `payload.movedFrom` is present —
   * this is the destination-side discovery path, since destination
   * streams don't render an inline `messages:moved` tombstone.
   */
  onShowMoveDetails?: () => void
}

/** A top-level action in the message context menu. */
export interface MessageAction {
  id: string
  /**
   * Visible menu label. Plain string for static entries; for actions whose
   * label depends on the message (e.g. "Share to #parent-name"), pass a
   * function that derives it from the context.
   */
  label: string | ((context: MessageActionContext) => string)
  icon: ComponentType<{ className?: string }>
  /**
   * Render a separator before this action in the menu. For grouped entries
   * (see {@link groupId}), only the group's primary action's `separatorBefore`
   * is honored — alternatives ride along the group.
   */
  separatorBefore?: boolean
  /** Visual variant — "destructive" renders in red */
  variant?: "destructive"
  /**
   * Group id for split-button grouping. Adjacent visible actions sharing the
   * same `groupId` collapse into one row: the first action is the primary
   * (default tap), the rest become alternatives reachable via a chevron-driven
   * dropdown. A group with only one visible action degrades to a regular row.
   * `groupVisibleActions` performs the collapse.
   */
  groupId?: string
  /** Controls visibility — evaluated by getVisibleActions */
  when: (context: MessageActionContext) => boolean
  /** URL for navigation actions — rendered as <Link> (INV-40) */
  getHref?: (context: MessageActionContext) => string | undefined
  /** Handler for mutation actions — rendered as <button> */
  action?: (context: MessageActionContext) => void | Promise<void>
}

/** Resolve the visible label for an action, handling the string/function variants. */
export function resolveActionLabel(action: MessageAction, context: MessageActionContext): string {
  return typeof action.label === "function" ? action.label(context) : action.label
}

/**
 * A grouped item in the rendered menu.
 *
 * - `single` — an ungrouped action (or a group whose only visible member
 *   degraded to a standalone row). Renders as a normal menu row.
 * - `group` — multiple visible same-`groupId` actions. The renderer shows
 *   `members[0]` as the row's primary tap target and exposes ALL members
 *   (including `members[0]`) in a chevron-driven dropdown so the menu is
 *   a complete list of options rather than "the alternatives". The first
 *   member is always the default — opening the dropdown should feel like
 *   a list with the default option pre-highlighted.
 */
export type GroupedActionItem = { kind: "single"; action: MessageAction } | { kind: "group"; members: MessageAction[] }

/**
 * Collapse adjacent same-`groupId` actions into split-button groups, leaving
 * ungrouped actions as `single` items. Order is preserved; grouped items
 * appear at the position of their first member. The first member becomes
 * the primary (default tap target); the dropdown lists every member so the
 * UI presents the full set of options rather than "the others".
 *
 * Same-group actions are expected to be defined adjacently in
 * {@link messageActions}; this is enforced by visibility filtering. A group
 * with only one visible member degrades to a `single` item — no chevron.
 */
export function groupVisibleActions(actions: MessageAction[]): GroupedActionItem[] {
  const items: GroupedActionItem[] = []
  let i = 0
  while (i < actions.length) {
    const action = actions[i]
    if (!action.groupId) {
      items.push({ kind: "single", action })
      i++
      continue
    }

    const members: MessageAction[] = [action]
    let j = i + 1
    while (j < actions.length && actions[j].groupId === action.groupId) {
      members.push(actions[j])
      j++
    }
    if (members.length === 1) {
      items.push({ kind: "single", action })
    } else {
      items.push({ kind: "group", members })
    }
    i = j
  }
  return items
}

// --- Helpers ---

async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
}

// --- Action definitions ---

export const messageActions: MessageAction[] = [
  {
    id: "show-trace",
    label: "Show trace and sources",
    icon: Sparkles,
    when: (ctx) => ctx.actorType === "persona" && !!ctx.sessionId && !!ctx.traceUrl,
    getHref: (ctx) => ctx.traceUrl,
  },
  {
    id: "edit-message",
    label: "Edit message",
    icon: Pencil,
    when: (ctx) =>
      ctx.actorType === "user" && !!ctx.authorId && ctx.authorId === ctx.currentUserId && ctx.e2eEnabled !== true,
    action: (ctx) => ctx.onEdit?.(),
  },
  {
    id: "see-revisions",
    label: "See revisions",
    icon: History,
    when: (ctx) => !!ctx.editedAt,
    action: (ctx) => ctx.onShowHistory?.(),
  },
  {
    id: "reply-in-thread",
    label: "Reply in thread",
    icon: MessageSquareReply,
    groupId: "reply",
    when: (ctx) => !ctx.isThreadParent,
    getHref: (ctx) => ctx.replyUrl,
  },
  {
    id: "quote-reply",
    label: "Quote reply",
    icon: Quote,
    groupId: "reply",
    when: (ctx) => !!ctx.onQuoteReply,
    action: (ctx) => ctx.onQuoteReply?.(),
  },
  {
    // Default share entry — opens the cross-stream picker modal. Listed
    // first in the group so `groupVisibleActions` makes it the primary
    // tap target; the share-to-root / share-to-parent fast paths ride
    // alongside as alternatives reachable via the chevron dropdown.
    id: "share",
    label: "Share message",
    icon: Share2,
    groupId: "share",
    when: (ctx) => !!ctx.onShare,
    action: (ctx) => ctx.onShare?.(),
  },
  {
    id: "share-to-root",
    label: (ctx) => ctx.shareToRootLabel ?? "Share to channel",
    icon: Share2,
    groupId: "share",
    when: (ctx) => !!ctx.onShareToRoot,
    action: (ctx) => ctx.onShareToRoot?.(),
  },
  {
    id: "share-to-parent",
    label: (ctx) => ctx.shareToParentLabel ?? "Share to parent thread",
    icon: Share2,
    groupId: "share",
    when: (ctx) => !!ctx.onShareToParent,
    action: (ctx) => ctx.onShareToParent?.(),
  },
  {
    // Save is the primary action in the save/reminder split group. Once a
    // message is already saved this row disappears; "Remove from Saved" stays
    // as a separate explicit action so we never silently unsave via a mislabeled
    // "Save for later" row.
    id: "save-message",
    label: "Save for later",
    icon: Bookmark,
    groupId: "save",
    when: (ctx) => !!ctx.onToggleSave && !ctx.isSaved,
    action: (ctx) => ctx.onToggleSave?.(),
  },
  {
    id: "set-reminder",
    // Mobile hover can't show the desktop popover, so mobile users get a
    // dedicated drawer entry that opens a bottom sheet with presets + a
    // custom-time dialog.
    label: "Set reminder…",
    icon: Bell,
    groupId: "save",
    when: (ctx) => !!ctx.onRequestReminder,
    action: (ctx) => ctx.onRequestReminder?.(),
  },
  {
    id: "unsave-message",
    label: "Remove from Saved",
    icon: BookmarkX,
    when: (ctx) => !!ctx.onToggleSave && !!ctx.isSaved,
    action: (ctx) => ctx.onToggleSave?.(),
  },
  {
    // Seed a private scratchpad that has this message's thread pre-loaded as
    // context — lets the user poke at a thread without polluting it with
    // @mentions.
    id: "discuss-with-ariadne",
    label: "Discuss with Ariadne",
    icon: Sparkles,
    when: (ctx) => !!ctx.onDiscussWithAriadne && !!ctx.streamId,
    action: (ctx) => ctx.onDiscussWithAriadne?.(),
  },
  {
    // Per-message entry into the move-to-thread flow. Mirrors the stream
    // header entry but seeds the selection with this single message so the
    // common "I just want this one in a thread" path is one tap shorter.
    id: "move-to-thread",
    label: "Move to thread…",
    icon: CornerDownRight,
    when: (ctx) => !!ctx.onMoveToThread,
    action: (ctx) => ctx.onMoveToThread?.(),
  },
  {
    // Destination-side discovery for messages that arrived via a move.
    // The destination doesn't render an inline tombstone — this entry
    // opens the same drill-in drawer the source-side tombstone does.
    id: "show-move-details",
    label: "Show move details",
    icon: CornerDownRight,
    when: (ctx) => !!ctx.onShowMoveDetails,
    action: (ctx) => ctx.onShowMoveDetails?.(),
  },
  {
    id: "copy-as-markdown",
    label: "Copy as Markdown",
    icon: FileText,
    separatorBefore: true,
    groupId: "copy",
    when: () => true,
    action: async (ctx) => {
      try {
        await copyToClipboard(ctx.contentMarkdown)
        toast.success("Copied as Markdown")
      } catch {
        toast.error("Failed to copy")
      }
    },
  },
  {
    id: "copy-as-plain-text",
    label: "Copy as Plain text",
    icon: Type,
    groupId: "copy",
    when: () => true,
    action: async (ctx) => {
      try {
        await copyToClipboard(stripMarkdown(ctx.contentMarkdown))
        toast.success("Copied as plain text")
      } catch {
        toast.error("Failed to copy")
      }
    },
  },
  {
    id: "copy-link",
    label: "Copy link to message",
    icon: Link2,
    when: (ctx) => !!ctx.messageId && !!ctx.workspaceId && !!ctx.streamId,
    action: async (ctx) => {
      try {
        const url = `${window.location.origin}/w/${ctx.workspaceId}/s/${ctx.streamId}?m=${ctx.messageId}`
        await copyToClipboard(url)
        toast.success("Link copied")
      } catch {
        toast.error("Failed to copy link")
      }
    },
  },
  {
    id: "delete-message",
    label: "Delete message",
    icon: Trash2,
    separatorBefore: true,
    variant: "destructive",
    when: (ctx) => ctx.actorType === "user" && !!ctx.authorId && ctx.authorId === ctx.currentUserId,
    action: (ctx) => ctx.onDelete?.(),
  },
]
/** Filter actions that should be shown for a given message context. */
export function getVisibleActions(context: MessageActionContext): MessageAction[] {
  return messageActions.filter((a) => a.when(context))
}
