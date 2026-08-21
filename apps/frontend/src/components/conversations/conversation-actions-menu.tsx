import { useEffect, useRef, useState } from "react"
import {
  CircleCheck,
  Eye,
  EyeOff,
  EllipsisVertical,
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
  type Stream,
  type TitleSource,
} from "@threa/types"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { useUpdateConversation, useHideConversation, useUnhideConversation } from "@/hooks/use-conversations"
import { ConversationSplitDialog } from "./conversation-split-dialog"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { effectiveConversationTitle } from "@/lib/conversations/title"
import { useRenameStream } from "@/hooks/use-rename-stream"
import { isProtectedRegenerableTitle, useRegenerateTitle } from "@/hooks/use-regenerate-title"
import { useOpenAside } from "@/hooks/use-open-aside"

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
  /** Extra classes for the trigger, so each surface can size it to its icon cluster. */
  triggerClassName?: string
}

/**
 * The `⋯` overflow on a board card / conversation panel: rename the topic and
 * mark the conversation resolved (or reopen it). Both edits go through
 * {@link useUpdateConversation} — optimistic, silent on success (the title/label
 * change is the confirmation, INV-63). Rename opens a {@link RenameConversationDialog}
 * rather than editing inline, so the card never shifts layout mid-edit (INV-21).
 */
export function ConversationActionsMenu({
  workspaceId,
  conversationId,
  streamId,
  topicSummary,
  topicSummarySource,
  status,
  isHidden = false,
  triggerClassName,
}: ConversationActionsMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [splitOpen, setSplitOpen] = useState(false)
  const update = useUpdateConversation(workspaceId)
  const streams = useWorkspaceStreams(workspaceId)
  const stream = streams.find((item) => item.id === streamId)
  const isScratchpad = stream?.type === StreamTypes.SCRATCHPAD
  const openAside = useOpenAside(workspaceId)
  const canOpenAside = !!streamId && isAsideHostType(stream?.type ?? "") && stream?.e2eEnabled !== true
  const effectiveTitle = effectiveConversationTitle({ streamId: streamId ?? "", topicSummary }, stream)
  const hide = useHideConversation(workspaceId)
  const unhide = useUnhideConversation(workspaceId)
  const resolved = status === ConversationStatuses.RESOLVED

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-8 w-8 text-muted-foreground hover:text-foreground", triggerClassName)}
            aria-label="Conversation actions"
          >
            <EllipsisVertical className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {isScratchpad && streamId ? (
            <ScratchpadRenameMenuItem
              workspaceId={workspaceId}
              streamId={streamId}
              onSelect={() => {
                setMenuOpen(false)
                setRenameOpen(true)
              }}
            />
          ) : (
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault()
                setMenuOpen(false)
                setRenameOpen(true)
              }}
            >
              <Pencil className="h-4 w-4" />
              Rename topic…
            </DropdownMenuItem>
          )}
          {isProtectedRegenerableTitle(
            effectiveTitle,
            isScratchpad ? stream?.displayNameSource : topicSummarySource
          ) && (
            <RegenerateTitleMenuItem
              workspaceId={workspaceId}
              target={
                isScratchpad && stream
                  ? { kind: "stream", stream, currentTitle: effectiveTitle! }
                  : {
                      kind: "conversation",
                      conversationId,
                      currentTitle: effectiveTitle!,
                      source: topicSummarySource,
                    }
              }
            />
          )}
          <DropdownMenuItem
            onSelect={() =>
              update.mutate({
                conversationId,
                status: resolved ? ConversationStatuses.ACTIVE : ConversationStatuses.RESOLVED,
              })
            }
          >
            {resolved ? <RotateCcw className="h-4 w-4" /> : <CircleCheck className="h-4 w-4" />}
            {resolved ? "Reopen" : "Mark resolved"}
          </DropdownMenuItem>
          {streamId && !isScratchpad && (
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault()
                setMenuOpen(false)
                setSplitOpen(true)
              }}
            >
              <Sparkles className="h-4 w-4" />
              Split with AI…
            </DropdownMenuItem>
          )}
          {canOpenAside && (
            <DropdownMenuItem
              onSelect={() => {
                void openAside({ kind: "conversation", hostStreamId: streamId!, conversationId }).catch(() => {
                  /* toast already surfaced inside the hook */
                })
              }}
            >
              <MessageSquareDashed className="h-4 w-4" />
              Open an aside
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => (isHidden ? unhide.mutate(conversationId) : hide.mutate(conversationId))}>
            {isHidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            {isHidden ? "Unhide from board" : "Hide from board"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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

function RegenerateTitleMenuItem(props: {
  workspaceId: string
  target:
    | {
        kind: "stream"
        stream: Pick<Stream, "id" | "e2eEnabled" | "displayNameSource">
        currentTitle: string
      }
    | { kind: "conversation"; conversationId: string; currentTitle: string; source?: TitleSource | null }
}) {
  const regeneration = useRegenerateTitle(props.workspaceId, props.target)
  const renameStream = useRenameStream(props.workspaceId, props.target.kind === "stream" ? props.target.stream.id : "")
  const disabled = regeneration.isPending || (props.target.kind === "stream" && !renameStream.canRename)
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={(event) => {
        event.preventDefault()
        void regeneration.regenerate().catch(() => undefined)
      }}
    >
      <Sparkles className="h-4 w-4" />
      {regeneration.isPending ? "Regenerating…" : "Regenerate title"}
    </DropdownMenuItem>
  )
}

function ScratchpadRenameMenuItem(props: { workspaceId: string; streamId: string; onSelect: () => void }) {
  const renameStream = useRenameStream(props.workspaceId, props.streamId)
  return (
    <DropdownMenuItem
      disabled={!renameStream.canRename}
      onSelect={(event) => {
        event.preventDefault()
        props.onSelect()
      }}
    >
      <Pencil className="h-4 w-4" />
      Rename scratchpad…
    </DropdownMenuItem>
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
