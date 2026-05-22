import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
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
import {
  StreamTypes,
  Visibilities,
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

  // 1. Notifications — all stream types
  sections.push(
    <NotificationSection
      key="notifications"
      workspaceId={workspaceId}
      streamId={stream.id}
      streamType={stream.type}
      notificationLevel={notificationLevel}
    />
  )

  // 2. Visibility
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

  // 3. Name / Slug / Display name
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

  // 4. Description
  if (isChannel || isDm) {
    sections.push(<DescriptionSection key="description" workspaceId={workspaceId} stream={stream} />)
  }

  // 5. System disclaimer
  if (isSystem) {
    sections.push(<SystemDisclaimerSection key="disclaimer" />)
  }

  // 6. Archive (danger zone)
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

  // Render with separators between consecutive sections only
  const nodes: React.ReactNode[] = []
  for (let i = 0; i < sections.length; i++) {
    if (i > 0) {
      nodes.push(<Separator key={`sep-${i}`} />)
    }
    nodes.push(sections[i])
  }

  return <div className="space-y-6 p-1">{nodes}</div>
}

// ─── Notification Section ───────────────────────────────────────────────────

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
      onSuccess: () => toast.success("Notification preference updated"),
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

// ─── Visibility Sections ────────────────────────────────────────────────────

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
        onSuccess: () => toast.success("Visibility updated"),
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

// ─── Name / Slug / Display Name Sections ────────────────────────────────────

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
        onSuccess: () => toast.success("Channel slug updated"),
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

  const handleSave = () => {
    if (!name.trim() || !hasChanged) return
    updateMutation.mutate(
      { displayName: name.trim() },
      {
        onSuccess: () => toast.success("Name updated"),
        onError: () => toast.error("Failed to update name"),
      }
    )
  }

  return (
    <div className="space-y-3">
      <Label className="text-sm font-medium">Display name</Label>
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Scratchpad name" maxLength={100} />
      {hasChanged && (
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

// ─── Description Section ────────────────────────────────────────────────────

function DescriptionSection({ workspaceId, stream }: { workspaceId: string; stream: Stream }) {
  const [description, setDescription] = useState(stream.description ?? "")
  const updateMutation = useUpdateStream(workspaceId, stream.id)
  const hasChanged = description !== (stream.description ?? "")

  const handleSave = () => {
    if (!hasChanged) return
    updateMutation.mutate(
      { description },
      {
        onSuccess: () => toast.success("Description updated"),
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

// ─── System Disclaimer Section ──────────────────────────────────────────────

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

// ─── Archive Section ────────────────────────────────────────────────────────

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
        onSuccess: () => toast.success(`${capitalize(streamTypeLabel)} unarchived`),
        onError: () => toast.error("Failed to unarchive"),
      })
    } else {
      archiveMutation.mutate(stream.id, {
        onSuccess: () => toast.success(`${capitalize(streamTypeLabel)} archived`),
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

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
