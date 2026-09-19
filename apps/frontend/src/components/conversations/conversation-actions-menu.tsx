import { cloneElement, useEffect, useRef, useState, type ReactElement } from "react"
import {
  CircleCheck,
  Eye,
  EyeOff,
  EllipsisVertical,
  Link2,
  MessageSquareDashed,
  Pencil,
  RotateCcw,
  Sparkles,
} from "lucide-react"
import {
  ConversationStatuses,
  MAX_CONVERSATION_TOPIC_LENGTH,
  StreamTypes,
  isAsideHostType,
  type TitleSource,
} from "@threahq/types"
import { Button } from "@/components/ui/button"
import {
  SidebarActionDrawer,
  SidebarActionMenu,
  type SidebarActionItem,
} from "@/components/layout/sidebar/sidebar-actions"
import { Input } from "@/components/ui/input"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { cn } from "@/lib/utils"
import { useIsMobileOrCoarse } from "@/hooks/use-pointer"
import { useUpdateConversation, useHideConversation, useUnhideConversation } from "@/hooks/use-conversations"
import { ConversationSplitDialog } from "./conversation-split-dialog"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { effectiveConversationTitle } from "@/lib/conversations/title"
import { useRenameStream } from "@/hooks/use-rename-stream"
import { isProtectedRegenerableTitle, useRegenerateTitle } from "@/hooks/use-regenerate-title"
import { useOpenAside } from "@/hooks/use-open-aside"
import { copyConversationLink } from "@/lib/stream-links"

interface ConversationActionsMenuProps {
  workspaceId: string
  conversationId: string
  /** The conversation's stream — the anchor for the AI-split mint. Omit to hide
   *  the "Split with AI" item (surfaces without a resolved stream id). */
  streamId?: string
  /** Current topic — prefilled into the rename dialog; null renders as empty. */
  topicSummary: string | null
  topicSummarySource?: TitleSource | null
  /** Current status — selects the resolve vs. reopen item. */
  status: string
  /** Whether this conversation is currently hidden from the viewer's board —
   *  selects "Unhide" vs "Hide from board". */
  isHidden?: boolean
  /** Shown as the touch drawer's title when the conversation has no topic of its
   *  own — the panel passes the stream locator it falls back to in the header. */
  titleFallback?: string
  /** Extra classes for the default trigger, so each surface can size it to its icon cluster. */
  triggerClassName?: string
  /** Replaces the default `⋮` trigger (the panel header uses the `⋯` its stream/thread peers use). */
  trigger?: ReactElement<{ onClick?: () => void }>
  /** Controlled open — lets a second affordance (the panel's title) drive the same menu. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/**
 * The overflow on a board card / conversation panel: rename the topic, resolve,
 * copy, split, hide. Built as {@link SidebarActionItem}s so it renders through
 * the same two surfaces every other menu in the app does — a dropdown on a fine
 * pointer, the bottom drawer on touch — instead of a dropdown a thumb has to
 * hit. Both edits go through {@link useUpdateConversation} — optimistic, silent
 * on success (the title/label change is the confirmation, INV-63). Rename opens
 * a {@link RenameConversationDialog} rather than editing inline, so the card
 * never shifts layout mid-edit (INV-21).
 */
export function ConversationActionsMenu({
  workspaceId,
  conversationId,
  streamId,
  topicSummary,
  topicSummarySource,
  status,
  isHidden = false,
  titleFallback,
  triggerClassName,
  trigger,
  open,
  onOpenChange,
}: ConversationActionsMenuProps) {
  const isTouch = useIsMobileOrCoarse()
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const menuOpen = open ?? uncontrolledOpen
  const setMenuOpen = (next: boolean) => {
    setUncontrolledOpen(next)
    onOpenChange?.(next)
  }
  const [renameOpen, setRenameOpen] = useState(false)
  const [splitOpen, setSplitOpen] = useState(false)
  const update = useUpdateConversation(workspaceId)
  const streams = useWorkspaceStreams(workspaceId)
  const stream = streams.find((item) => item.id === streamId)
  const isScratchpad = stream?.type === StreamTypes.SCRATCHPAD
  const openAside = useOpenAside(workspaceId)
  const canOpenAside =
    !!streamId && isAsideHostType(stream?.type ?? "") && stream?.e2eEnabled !== true && !stream?.archivedAt
  const effectiveTitle = effectiveConversationTitle({ streamId: streamId ?? "", topicSummary }, stream)
  const hide = useHideConversation(workspaceId)
  const unhide = useUnhideConversation(workspaceId)
  const resolved = status === ConversationStatuses.RESOLVED
  const renameStream = useRenameStream(workspaceId, streamId ?? "")
  const regeneration = useRegenerateTitle(
    workspaceId,
    isScratchpad && stream
      ? { kind: "stream", stream, currentTitle: effectiveTitle ?? "" }
      : { kind: "conversation", conversationId, currentTitle: effectiveTitle ?? "", source: topicSummarySource }
  )

  const actions: SidebarActionItem[] = []
  if (!isScratchpad || !streamId) {
    actions.push({ id: "rename", label: "Rename topic…", icon: Pencil, onSelect: () => setRenameOpen(true) })
  } else if (renameStream.canRename) {
    actions.push({ id: "rename", label: "Rename scratchpad…", icon: Pencil, onSelect: () => setRenameOpen(true) })
  }
  if (
    effectiveTitle &&
    isProtectedRegenerableTitle(effectiveTitle, isScratchpad ? stream?.displayNameSource : topicSummarySource) &&
    (!isScratchpad || renameStream.canRename)
  ) {
    actions.push({
      id: "regenerate",
      label: regeneration.isPending ? "Regenerating…" : "Regenerate title",
      icon: Sparkles,
      // The hook toasts its own failures; swallow so the menu doesn't toast twice.
      // Action rows carry no disabled state, so the in-flight guard lives here.
      onSelect: () => {
        if (regeneration.isPending) return
        void regeneration.regenerate().catch(() => undefined)
      },
    })
  }
  actions.push({
    id: "status",
    label: resolved ? "Reopen" : "Mark resolved",
    icon: resolved ? RotateCcw : CircleCheck,
    onSelect: () =>
      update.mutate({
        conversationId,
        status: resolved ? ConversationStatuses.ACTIVE : ConversationStatuses.RESOLVED,
      }),
  })
  actions.push({
    id: "copy-link",
    label: "Copy link",
    icon: Link2,
    onSelect: () => copyConversationLink(workspaceId, conversationId),
  })
  if (streamId && !isScratchpad) {
    actions.push({ id: "split", label: "Split with AI…", icon: Sparkles, onSelect: () => setSplitOpen(true) })
  }
  if (canOpenAside) {
    actions.push({
      id: "aside",
      label: "Open an aside",
      icon: MessageSquareDashed,
      onSelect: () =>
        openAside({ kind: "conversation", hostStreamId: streamId!, conversationId }).catch(() => {
          /* toast already surfaced inside the hook */
        }),
    })
  }
  actions.push({
    id: "visibility",
    label: isHidden ? "Unhide from board" : "Hide from board",
    icon: isHidden ? Eye : EyeOff,
    separatorBefore: true,
    onSelect: () => (isHidden ? unhide.mutate(conversationId) : hide.mutate(conversationId)),
  })

  const triggerNode = trigger ?? (
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-8 w-8 text-muted-foreground hover:text-foreground", triggerClassName)}
      aria-label="Conversation actions"
    >
      <EllipsisVertical className="h-3.5 w-3.5" />
    </Button>
  )

  return (
    <>
      {isTouch ? (
        <>
          {cloneElement(triggerNode, { onClick: () => setMenuOpen(true) })}
          <SidebarActionDrawer
            open={menuOpen}
            onOpenChange={setMenuOpen}
            actions={actions}
            title="Conversation actions"
            description="Choose an action for this conversation."
            header={
              <div className="px-4 pt-2 pb-3">
                <p className="break-words text-base font-semibold text-foreground">
                  {effectiveTitle ?? titleFallback ?? "Conversation"}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">Conversation actions</p>
              </div>
            }
          />
        </>
      ) : (
        <SidebarActionMenu
          actions={actions}
          ariaLabel="Conversation actions"
          trigger={triggerNode}
          open={menuOpen}
          onOpenChange={setMenuOpen}
        />
      )}
      {isScratchpad && streamId ? (
        <ScratchpadRenameDialog
          workspaceId={workspaceId}
          streamId={streamId}
          open={renameOpen}
          onOpenChange={setRenameOpen}
          initialTopic={effectiveTitle ?? ""}
        />
      ) : (
        <RenameConversationDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          initialTopic={effectiveTitle ?? ""}
          title="Rename topic"
          onSave={(next) => update.mutateAsync({ conversationId, topicSummary: next }).then(() => undefined)}
        />
      )}
      {streamId && !isScratchpad && (
        <ConversationSplitDialog
          workspaceId={workspaceId}
          streamId={streamId}
          conversationId={splitOpen ? conversationId : null}
          open={splitOpen}
          onOpenChange={setSplitOpen}
        />
      )}
    </>
  )
}

function ScratchpadRenameDialog(props: {
  workspaceId: string
  streamId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTopic: string
}) {
  const renameStream = useRenameStream(props.workspaceId, props.streamId)
  return (
    <RenameConversationDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      initialTopic={props.initialTopic}
      title="Rename scratchpad"
      onSave={renameStream.rename}
    />
  )
}

interface RenameConversationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTopic: string
  onSave: (topic: string) => Promise<void>
  title: string
}

function RenameConversationDialog({ open, onOpenChange, initialTopic, onSave, title }: RenameConversationDialogProps) {
  const [value, setValue] = useState(initialTopic)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Re-seed only on an open transition (a different card, or a re-open after
  // cancel) — NOT whenever `initialTopic` changes, so a concurrent rename landing
  // via the live query while you're typing doesn't wipe your in-progress input.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) setValue(initialTopic)
    wasOpen.current = open
  }, [open, initialTopic])

  const trimmed = value.trim()
  const canSave = trimmed.length > 0 && trimmed !== initialTopic.trim()

  const save = async () => {
    if (!canSave || isSaving) return
    setIsSaving(true)
    setSaveError(null)
    try {
      await onSave(trimmed)
      onOpenChange(false)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to rename")
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{title}</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <Input
            autoFocus
            value={value}
            maxLength={MAX_CONVERSATION_TOPIC_LENGTH}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                void save()
              }
            }}
            placeholder="Topic name"
          />
          {saveError && <p className="text-sm text-destructive">{saveError}</p>}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!canSave || isSaving}>
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
