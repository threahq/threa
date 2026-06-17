import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { VisibilityPicker } from "@/components/ui/visibility-picker"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogDescription,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/components/ui/responsive-alert-dialog"
import { ChannelSlugInput } from "./channel-slug-input"
import { getStreamName } from "@/lib/streams"
import { useUpdateStream, useArchiveStream, useUnarchiveStream, useSetNotificationLevel } from "@/hooks"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useE2eSession } from "@/stores/e2e-session-store"
import { sealStreamRename } from "@/lib/crypto/stream-rename"
import {
  StreamTypes,
  Visibilities,
  MemoryModes,
  NOTIFICATION_CONFIG,
  type Stream,
  type StreamType,
  type NotificationLevel,
  type Visibility,
} from "@threa/types"
import { toast } from "sonner"

interface GeneralTabProps {
  workspaceId: string
  stream: Stream
  currentUserId: string
  notificationLevel: NotificationLevel | null
  dmDisplayName?: string | null
  rootStream?: Stream | null
}

export function GeneralTab({
  workspaceId,
  stream,
  currentUserId,
  notificationLevel,
  dmDisplayName,
  rootStream,
}: GeneralTabProps) {
  const isChannel = stream.type === StreamTypes.CHANNEL
  const isScratchpad = stream.type === StreamTypes.SCRATCHPAD
  const isDm = stream.type === StreamTypes.DM
  const isThread = stream.type === StreamTypes.THREAD
  const isSystem = stream.type === StreamTypes.SYSTEM

  // Build sections dynamically so we never render orphan or stacked dividers
  const sections: React.ReactNode[] = []

  sections.push(
    <NotificationSection
      key="notifications"
      workspaceId={workspaceId}
      streamId={stream.id}
      streamType={stream.type}
      notificationLevel={notificationLevel}
    />
  )

  if (isChannel) {
    sections.push(<VisibilitySection key="visibility" workspaceId={workspaceId} stream={stream} />)
  } else if (isScratchpad) {
    sections.push(<VisibilityDisplay key="visibility" label="Visibility" hint="Scratchpads are always private" />)
  } else if (isDm) {
    sections.push(<VisibilityDisplay key="visibility" label="Visibility" hint="DMs are always private" />)
  } else if (isThread && rootStream) {
    sections.push(
      <ThreadVisibilityDisplay
        key="visibility"
        inheritedVisibility={rootStream.visibility}
        rootStreamName={getStreamName(rootStream) ?? "parent stream"}
      />
    )
  } else if (isThread) {
    sections.push(
      <VisibilityDisplay
        key="visibility"
        label="Visibility"
        hint="Threads inherit visibility from their parent stream"
      />
    )
  } else if (isSystem) {
    sections.push(<VisibilityDisplay key="visibility" label="Visibility" hint="System messages are always private" />)
  }

  if (isChannel) {
    sections.push(<SlugSection key="name" workspaceId={workspaceId} stream={stream} />)
  } else if (isScratchpad) {
    sections.push(<DisplayNameSection key="name" workspaceId={workspaceId} stream={stream} />)
  } else if (isDm) {
    sections.push(
      <DmDisplayNameSection key="name" displayName={dmDisplayName ?? stream.displayName ?? "Direct message"} />
    )
  } else if (isThread) {
    sections.push(<ThreadDisplayNameSection key="name" displayName={stream.displayName ?? "Thread"} />)
  }

  if (isChannel || isDm) {
    sections.push(<DescriptionSection key="description" workspaceId={workspaceId} stream={stream} />)
  }

  // Memory automation is a per-stream gate on GAM extraction. Threads inherit
  // from their root; DMs and system streams reject general updates
  // (STREAM_IMMUTABLE), so the toggle lives on the updatable memo producers.
  if (isChannel || isScratchpad) {
    sections.push(<MemorySection key="memory" workspaceId={workspaceId} stream={stream} />)
  }

  if (isSystem) {
    sections.push(<SystemDisclaimerSection key="disclaimer" />)
  }

  if (isChannel || isScratchpad || isThread) {
    let archiveLabel: string
    if (isChannel) {
      archiveLabel = "channel"
    } else if (isScratchpad) {
      archiveLabel = "scratchpad"
    } else {
      archiveLabel = "thread"
    }
    sections.push(
      <ArchiveSection
        key="archive"
        workspaceId={workspaceId}
        stream={stream}
        currentUserId={currentUserId}
        streamTypeLabel={archiveLabel}
      />
    )
  }

  const nodes: React.ReactNode[] = []
  for (let i = 0; i < sections.length; i++) {
    if (i > 0) {
      nodes.push(<Separator key={`sep-${i}`} />)
    }
    nodes.push(sections[i])
  }

  return <div className="space-y-6 p-1">{nodes}</div>
}

const NOTIFICATION_OPTION_META: Record<string, { label: string; description: string }> = {
  default: { label: "Default", description: "Use workspace notification settings" },
  everything: { label: "Everything", description: "All messages and activity" },
  activity: { label: "Activity", description: "Mentions, reactions, and thread replies" },
  mentions: { label: "Mentions only", description: "Only when you're @mentioned" },
  muted: { label: "Muted", description: "No notifications from this stream" },
}

function NotificationSection({
  workspaceId,
  streamId,
  streamType,
  notificationLevel,
}: {
  workspaceId: string
  streamId: string
  streamType: StreamType
  notificationLevel: NotificationLevel | null
}) {
  const mutation = useSetNotificationLevel(workspaceId, streamId)
  const currentValue = notificationLevel ?? "default"
  const { allowedLevels, defaultLevel } = NOTIFICATION_CONFIG[streamType]
  const defaultMeta = NOTIFICATION_OPTION_META[defaultLevel]
  const defaultDescription = defaultMeta
    ? `Use stream default (${defaultMeta.label.toLowerCase()})`
    : "Use stream default"

  const handleChange = (value: string) => {
    const level = value === "default" ? null : (value as NotificationLevel)
    mutation.mutate(level, {
      onError: () => toast.error("Failed to update notification preference"),
    })
  }

  const options = [
    { value: "default", label: "Default", description: defaultDescription },
    ...allowedLevels.map((level) => ({
      value: level,
      ...NOTIFICATION_OPTION_META[level],
    })),
  ]

  return (
    <div className="space-y-3">
      <Label className="text-sm font-medium">Notifications</Label>
      <Select value={currentValue} onValueChange={handleChange} disabled={mutation.isPending}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              <span className="font-medium">{opt.label}</span>
              <span className="text-muted-foreground ml-2 text-xs">{opt.description}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function VisibilitySection({ workspaceId, stream }: { workspaceId: string; stream: Stream }) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pendingVisibility, setPendingVisibility] = useState<"public" | "private" | null>(null)
  const updateMutation = useUpdateStream(workspaceId, stream.id)

  const handleVisibilityChange = (value: string) => {
    if (value === stream.visibility) return
    setPendingVisibility(value as "public" | "private")
    setConfirmOpen(true)
  }

  const handleConfirm = () => {
    if (!pendingVisibility) return
    updateMutation.mutate(
      { visibility: pendingVisibility },
      {
        onError: () => toast.error("Failed to update visibility"),
      }
    )
    setConfirmOpen(false)
    setPendingVisibility(null)
  }

  const handleCancel = () => {
    setConfirmOpen(false)
    setPendingVisibility(null)
  }

  return (
    <div className="space-y-3">
      <Label className="text-sm font-medium">Visibility</Label>
      <VisibilityPicker value={stream.visibility} onChange={handleVisibilityChange} />

      <ResponsiveAlertDialog open={confirmOpen} onOpenChange={handleCancel}>
        <ResponsiveAlertDialogContent>
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>Change visibility?</ResponsiveAlertDialogTitle>
            <ResponsiveAlertDialogDescription>
              {pendingVisibility === Visibilities.PRIVATE
                ? "Making this channel private will hide it from non-members. They won't be able to find or join it."
                : "Making this channel public will make it visible to all workspace users. Anyone will be able to join."}
            </ResponsiveAlertDialogDescription>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>Cancel</ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction onClick={handleConfirm}>Confirm</ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </div>
  )
}

function VisibilityDisplay({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="space-y-3">
      <Label className="text-sm font-medium">{label}</Label>
      <VisibilityPicker value="private" onChange={() => {}} disabled />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

function ThreadVisibilityDisplay({
  inheritedVisibility,
  rootStreamName,
}: {
  inheritedVisibility: Visibility
  rootStreamName: string
}) {
  return (
    <div className="space-y-3">
      <Label className="text-sm font-medium">Visibility</Label>
      <VisibilityPicker value={inheritedVisibility} onChange={() => {}} disabled />
      <p className="text-xs text-muted-foreground">Threads inherit visibility from {rootStreamName}</p>
    </div>
  )
}

function SlugSection({ workspaceId, stream }: { workspaceId: string; stream: Stream }) {
  const [slug, setSlug] = useState(stream.slug ?? "")
  const [isValid, setIsValid] = useState(true)
  const updateMutation = useUpdateStream(workspaceId, stream.id)
  const hasChanged = slug !== (stream.slug ?? "")

  const handleSave = () => {
    if (!isValid || !hasChanged) return
    updateMutation.mutate(
      { slug },
      {
        onError: () => toast.error("Failed to update slug"),
      }
    )
  }

  return (
    <div className="space-y-3">
      <Label className="text-sm font-medium">Channel name</Label>
      <ChannelSlugInput
        workspaceId={workspaceId}
        streamId={stream.id}
        currentSlug={stream.slug ?? ""}
        value={slug}
        onChange={setSlug}
        onValidityChange={setIsValid}
      />
      {hasChanged && (
        <Button size="sm" onClick={handleSave} disabled={!isValid || updateMutation.isPending}>
          {updateMutation.isPending ? "Saving..." : "Save"}
        </Button>
      )}
    </div>
  )
}

function DisplayNameSection({ workspaceId, stream }: { workspaceId: string; stream: Stream }) {
  const [name, setName] = useState(stream.displayName ?? "")
  const updateMutation = useUpdateStream(workspaceId, stream.id)
  const hasChanged = name !== (stream.displayName ?? "")

  // An E2E scratchpad's name is sealed-only — renaming seals the new name under
  // the stream key and never writes plaintext (INV-E1), so it needs an unlocked
  // session. While locked the field is read-only and points the user at unlock.
  const isEncrypted = !!stream.e2eEnabled
  const currentUserId = useWorkspaceUserId(workspaceId)
  const e2eUnlocked = useE2eSession(workspaceId, currentUserId ?? "").status === "unlocked"
  const locked = isEncrypted && !e2eUnlocked

  const handleSave = async () => {
    const trimmed = name.trim()
    if (!trimmed || !hasChanged || locked) return
    try {
      const data = isEncrypted
        ? await sealStreamRename({ workspaceId, streamId: stream.id, userId: currentUserId ?? "", name: trimmed })
        : { displayName: trimmed }
      updateMutation.mutate(data, {
        onError: () => toast.error("Failed to update name"),
      })
    } catch {
      toast.error("Unlock this scratchpad to rename it")
    }
  }

  return (
    <div className="space-y-3">
      <Label className="text-sm font-medium">Display name</Label>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Scratchpad name"
        maxLength={100}
        disabled={locked}
      />
      {locked && <p className="text-xs text-muted-foreground">Unlock this scratchpad to rename it.</p>}
      {hasChanged && !locked && (
        <Button size="sm" onClick={handleSave} disabled={!name.trim() || updateMutation.isPending}>
          {updateMutation.isPending ? "Saving..." : "Save"}
        </Button>
      )}
    </div>
  )
}

function DmDisplayNameSection({ displayName }: { displayName: string }) {
  return (
    <div className="space-y-3">
      <Label className="text-sm font-medium">Virtual stream name</Label>
      <Input value={displayName} disabled readOnly className="bg-muted/50" />
      <p className="text-xs text-muted-foreground">This name is for display only and cannot be edited.</p>
    </div>
  )
}

function ThreadDisplayNameSection({ displayName }: { displayName: string }) {
  return (
    <div className="space-y-3">
      <Label className="text-sm font-medium">Display name</Label>
      <Input value={displayName} disabled readOnly className="bg-muted/50" />
    </div>
  )
}

function DescriptionSection({ workspaceId, stream }: { workspaceId: string; stream: Stream }) {
  const [description, setDescription] = useState(stream.description ?? "")
  const updateMutation = useUpdateStream(workspaceId, stream.id)
  const hasChanged = description !== (stream.description ?? "")

  const handleSave = () => {
    if (!hasChanged) return
    updateMutation.mutate(
      { description },
      {
        onError: () => toast.error("Failed to update description"),
      }
    )
  }

  return (
    <div className="space-y-3">
      <Label className="text-sm font-medium">Description</Label>
      <Textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={stream.type === StreamTypes.CHANNEL ? "What is this channel about?" : "Add a description…"}
        maxLength={500}
        rows={3}
      />
      <div className="flex items-center justify-between">
        {hasChanged && (
          <Button size="sm" onClick={handleSave} disabled={updateMutation.isPending}>
            {updateMutation.isPending ? "Saving..." : "Save"}
          </Button>
        )}
        <span className="text-xs text-muted-foreground ml-auto">{description.length}/500</span>
      </div>
    </div>
  )
}

function MemorySection({ workspaceId, stream }: { workspaceId: string; stream: Stream }) {
  const updateMutation = useUpdateStream(workspaceId, stream.id)
  // Absent on legacy cached rows synced before this shipped; treat as auto.
  const memoryOn = (stream.memoryMode ?? MemoryModes.AUTO) === MemoryModes.AUTO

  const handleChange = (checked: boolean) => {
    const memoryMode = checked ? MemoryModes.AUTO : MemoryModes.OFF
    if (memoryMode === (stream.memoryMode ?? MemoryModes.AUTO)) return
    // Success is silent (INV-63) — the switch reflects the new state itself.
    updateMutation.mutate({ memoryMode }, { onError: () => toast.error("Failed to update memory setting") })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <Label htmlFor="memory-automation" className="text-sm font-medium">
            Automatic memory
          </Label>
          <p className="text-xs text-muted-foreground">
            Extract and save knowledge from this stream's conversations. Turn off for high-volume streams where captured
            memories add noise.
          </p>
        </div>
        <Switch
          id="memory-automation"
          checked={memoryOn}
          onCheckedChange={handleChange}
          disabled={updateMutation.isPending}
        />
      </div>
    </div>
  )
}

function SystemDisclaimerSection() {
  return (
    <div className="space-y-3">
      <Label className="text-sm font-medium">About</Label>
      <p className="text-sm text-muted-foreground">
        This stream contains automated system messages. It is read-only and cannot be configured beyond notification
        preferences.
      </p>
    </div>
  )
}

function ArchiveSection({
  workspaceId,
  stream,
  currentUserId,
  streamTypeLabel,
}: {
  workspaceId: string
  stream: Stream
  currentUserId: string
  streamTypeLabel: string
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const archiveMutation = useArchiveStream(workspaceId)
  const unarchiveMutation = useUnarchiveStream(workspaceId)
  const isCreator = stream.createdBy === currentUserId
  const isArchived = stream.archivedAt !== null

  if (!isCreator) return null

  const handleAction = () => {
    if (isArchived) {
      unarchiveMutation.mutate(stream.id, {
        onError: () => toast.error("Failed to unarchive"),
      })
    } else {
      archiveMutation.mutate(stream.id, {
        onError: () => toast.error("Failed to archive"),
      })
    }
    setConfirmOpen(false)
  }

  const streamName = getStreamName(stream) ?? `this ${streamTypeLabel}`

  return (
    <div className="space-y-3">
      <Label className="text-sm font-medium text-muted-foreground">Danger zone</Label>
      <div className="rounded-lg border border-destructive/20 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {isArchived ? "Unarchive" : "Archive"} {streamTypeLabel}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {isArchived
                ? `Restore this ${streamTypeLabel} to the sidebar for all members.`
                : `Hide this ${streamTypeLabel} from the sidebar. You can unarchive it later.`}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/30"
            onClick={() => setConfirmOpen(true)}
          >
            {isArchived ? "Unarchive" : "Archive"}
          </Button>
        </div>
      </div>

      <ResponsiveAlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <ResponsiveAlertDialogContent>
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {isArchived ? "Unarchive" : "Archive"} {streamName}?
            </ResponsiveAlertDialogTitle>
            <ResponsiveAlertDialogDescription>
              {isArchived
                ? "This stream will be visible in the sidebar again."
                : "This stream will be hidden from the sidebar. You can unarchive it later."}
            </ResponsiveAlertDialogDescription>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>Cancel</ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction onClick={handleAction}>
              {isArchived ? "Unarchive" : "Archive"}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </div>
  )
}
