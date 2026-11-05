import { Fragment, useState } from "react"
import { ChevronDown } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { VISIBILITY_HINTS } from "@/components/ui/visibility-picker"
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
import {
  ChoiceSetting,
  SETTING_CONTROL_HEIGHT,
  SETTING_CONTROL_WIDTH,
  SettingRow,
  SettingStateAction,
  SettingValue,
  SettingsSection,
  SwitchSetting,
  settingIds,
  SaveError,
  SaveIndicator,
} from "@/components/settings/setting-primitives"
import {
  SETTING_CHOICE_LABELS,
  settingDef,
  streamNotifyDefaultChoice,
  type StreamSettingId,
  upperFirst,
} from "@/components/settings/settings-registry"
import { useCommittedText } from "@/components/settings/committed-field"
import { ChannelSlugInput } from "./channel-slug-input"
import { DescriptionSection } from "./description-section"
import { cn } from "@/lib/utils"
import { canChangeArchiveState, getStreamName, getStreamTypeLabel, streamFallbackLabel } from "@/lib/streams"
import { VISIBILITY_LABELS } from "@/lib/stream-visuals"
import { useUpdateStream, useArchiveStream, useUnarchiveStream, useSetNotificationLevel } from "@/hooks"
import { useRenameStream } from "@/hooks/use-rename-stream"
import { useCanManageChannels } from "@/lib/use-can-manage-channels"
import { useEffectiveArchived } from "@/hooks/use-effective-archived"
import { useStreamName } from "@/hooks/use-stream-name"
import { isProtectedRegenerableTitle, useRegenerateTitle } from "@/hooks/use-regenerate-title"
import {
  StreamTypes,
  Visibilities,
  MemoryModes,
  NOTIFICATION_CONFIG,
  type Stream,
  type StreamType,
  type NotificationLevel,
  type Visibility,
  isChannelLike,
  isValidSlug,
  resolveNotificationPause,
} from "@threahq/types"
import { toast } from "sonner"
import { usePreferencesOptional } from "@/contexts/preferences-context"
import { useOptionalSettings } from "@/contexts/settings-context"
import { useCurrentWorkspaceUser } from "@/hooks/use-workspaces"
import { formatNotificationPauseLabel } from "@/lib/status"
import { SettingsLink } from "@/components/workspace-settings/settings-link"
import { resolvePushDeviceState } from "@/hooks/push-device-state"
import { usePushNotifications } from "@/hooks/use-push-notifications"
import { STREAM_LETS_THROUGH, summarizeStreamPush, type StreamPushInput } from "./stream-push-summary"
import { useInheritedNotificationLevel } from "./use-inherited-notification-level"

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
  const channelLike = isChannelLike(stream)
  const canManageChannels = useCanManageChannels(workspaceId)
  const channelLocked = channelLike && !canManageChannels
  const conversation = isChannel || isScratchpad || isDm

  let name: React.ReactNode = null
  if (isChannel) name = <SlugRow workspaceId={workspaceId} stream={stream} locked={channelLocked} />
  else if (isScratchpad) name = <DisplayNameRow workspaceId={workspaceId} stream={stream} />
  else if (isDm)
    name = (
      <ReadOnlyRow
        setting="stream-name"
        value={dmDisplayName ?? stream.displayName ?? "Direct message"}
        description="A direct message is named after the people in it."
      />
    )
  else if (isThread) name = <ThreadNameRow workspaceId={workspaceId} stream={stream} />

  let visibility: React.ReactNode = null
  if (channelLike) {
    visibility = <VisibilityRow workspaceId={workspaceId} stream={stream} locked={channelLocked} />
  } else if (isThread) {
    visibility = (
      <ReadOnlyRow
        setting="stream-visibility"
        value={rootStream ? VISIBILITY_LABELS[rootStream.visibility] : "Inherited"}
        description={`Threads follow ${(rootStream && getStreamName(rootStream)) ?? "their parent stream"}.`}
      />
    )
  } else if (isScratchpad || isDm || isSystem) {
    visibility = (
      <ReadOnlyRow
        setting="stream-visibility"
        value={VISIBILITY_LABELS.private}
        description={`${getStreamTypeLabel(stream.type)}s are always private.`}
      />
    )
  }

  return (
    <div className="space-y-8">
      {stream.type !== StreamTypes.DOC && (
        <SettingsSection section="stream-notify">
          <NotificationRow
            workspaceId={workspaceId}
            stream={stream}
            notificationLevel={notificationLevel}
            note={
              isSystem ? "Automated system messages. It's read-only, so notifications are all there is to set." : null
            }
          />
        </SettingsSection>
      )}

      {(name || visibility || conversation) && (
        <SettingsSection section="stream-details">
          {name}
          {conversation && (
            <SettingRow setting="stream-description" labelFor={false} stacked>
              <DescriptionSection workspaceId={workspaceId} stream={stream} locked={channelLocked} />
            </SettingRow>
          )}
          {visibility}
        </SettingsSection>
      )}

      {conversation && (
        <SettingsSection section="stream-memory">
          <MemoryRow workspaceId={workspaceId} stream={stream} locked={channelLocked} />
        </SettingsSection>
      )}

      {(isChannel || isScratchpad || isThread) && (
        <ArchiveSection
          workspaceId={workspaceId}
          stream={stream}
          rootStream={rootStream ?? null}
          currentUserId={currentUserId}
          locked={channelLocked}
        />
      )}
    </div>
  )
}

/** Mentions only says it all in its label. */
const NOTIFICATION_OPTION_DESCRIPTIONS: Partial<Record<NotificationLevel, string>> = {
  everything: `${upperFirst(STREAM_LETS_THROUGH.everything)}.`,
  activity: `${upperFirst(STREAM_LETS_THROUGH.activity)}.`,
  muted: "Stays out of your inbox.",
}

/**
 * What the default option follows and what that gives now, so it reads as
 * "follow", not as a second copy of the level it currently equals. A stream
 * with a parent also says that muting the parent mutes it.
 */
function defaultLevelDescription(
  level: NotificationLevel,
  streamType: StreamType,
  followsParent: boolean,
  parentName: string | null
): string {
  const now = SETTING_CHOICE_LABELS["stream-notifications"][level].toLowerCase()
  if (followsParent && parentName) return `Follows ${parentName}, now ${now}.`
  const follows = `Follows the default for ${streamFallbackLabel(streamType, "noun")}s, now ${now}.`
  return parentName && level !== "muted" ? `${follows} Mutes with ${parentName}.` : follows
}

/** An explicit level equal to what the default gives now: the same today, but it stays when the default moves. */
const MATCHES_DEFAULT = "Same as the default now, but stays if the default changes."

function NotificationRow({
  workspaceId,
  stream,
  notificationLevel,
  note,
}: {
  workspaceId: string
  stream: Stream
  notificationLevel: NotificationLevel | null
  /** What kind of stream this is, where that explains why there's little else to set. */
  note: string | null
}) {
  const mutation = useSetNotificationLevel(workspaceId, stream.id)
  const labels = SETTING_CHOICE_LABELS["stream-notifications"]
  const { allowedLevels } = NOTIFICATION_CONFIG[stream.type]
  const inherited = useInheritedNotificationLevel(workspaceId, stream)
  const parentId = inherited.fromStreamId ?? stream.parentStreamId
  const parentName = useStreamName(workspaceId, parentId ?? "") ?? (parentId ? "its parent" : null)

  const handleChange = (value: string) => {
    const level = value === "default" ? null : (value as NotificationLevel)
    mutation.mutate(level, {
      onError: () => toast.error("Failed to update notification preference"),
    })
  }

  return (
    <ChoiceSetting
      setting="stream-notifications"
      variant="list"
      value={notificationLevel ?? "default"}
      options={[
        {
          value: "default",
          label: streamNotifyDefaultChoice(stream.type).label,
          description: defaultLevelDescription(
            inherited.level,
            stream.type,
            inherited.fromStreamId !== null,
            parentName
          ),
        },
        ...allowedLevels.map((level) => {
          const about = NOTIFICATION_OPTION_DESCRIPTIONS[level]
          const matches = level === inherited.level
          return {
            value: level,
            label: labels[level],
            description: matches ? [about, MATCHES_DEFAULT].filter(Boolean).join(" ") : about,
          }
        }),
      ]}
      onValueChange={handleChange}
      disabled={mutation.isPending}
      description={
        <>
          {settingDef("stream-notifications").description}
          {note && <span className="mt-0.5 block">{note}</span>}
          <StreamPushLine
            workspaceId={workspaceId}
            streamType={stream.type}
            level={notificationLevel}
            inherited={{
              level: inherited.level,
              from:
                inherited.fromStreamId && parentName ? { name: parentName, streamId: inherited.fromStreamId } : null,
            }}
          />
        </>
      }
    />
  )
}

/** What actually pushes from this stream, with the layers behind it (account level, pause, quiet hours, this device) one tap away. */
function StreamPushLine({
  workspaceId,
  streamType,
  level,
  inherited,
}: {
  workspaceId: string
  streamType: StreamType
  level: NotificationLevel | null
  inherited: StreamPushInput["inherited"]
}) {
  const settings = useOptionalSettings()
  const preferences = usePreferencesOptional()?.preferences
  const currentUser = useCurrentWorkspaceUser(workspaceId)
  const device = resolvePushDeviceState(usePushNotifications(workspaceId))
  const [open, setOpen] = useState(false)
  if (!preferences) return null
  const pause = currentUser ? resolveNotificationPause(currentUser) : null
  const { result, reasons } = summarizeStreamPush(
    {
      streamType,
      level,
      inherited,
      account: preferences.notificationLevel,
      quietOutsideWorkingHours: preferences.quietOutsideWorkingHours ?? false,
      pauseLabel: pause ? formatNotificationPauseLabel(pause) : null,
      device,
    },
    streamFallbackLabel(streamType, "noun")
  )
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <span className="mt-0.5 block">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span data-testid="stream-push-summary">{result}</span>
          <CollapsibleTrigger className="group relative inline-flex items-center gap-0.5 rounded-sm font-medium text-foreground underline underline-offset-2 after:absolute after:-inset-x-1 after:-inset-y-3.5 after:content-[''] hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:after:hidden">
            Why
            <ChevronDown
              aria-hidden
              className="size-3.5 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
            />
          </CollapsibleTrigger>
        </span>
        <CollapsibleContent asChild>
          <span className="block" data-testid="stream-push-reasons">
            {reasons.map((reason, index) => (
              <span key={index} className="mt-0.5 block">
                {reason.map((part, partIndex) => {
                  if (typeof part === "string") return <Fragment key={partIndex}>{part}</Fragment>
                  if ("setting" in part) {
                    return (
                      <SettingsLink key={partIndex} setting={part.setting}>
                        {part.text}
                      </SettingsLink>
                    )
                  }
                  if (!settings) return <Fragment key={partIndex}>{part.text}</Fragment>
                  return (
                    <SettingsLink
                      key={partIndex}
                      to={settings.getStreamSettingsUrl(part.streamId, "general", "stream-notifications")}
                    >
                      {part.text}
                    </SettingsLink>
                  )
                })}
              </span>
            ))}
          </span>
        </CollapsibleContent>
      </span>
    </Collapsible>
  )
}

function visibilityChangeCopy(from: Visibility, to: Visibility, noun: string): string {
  if (to === Visibilities.PRIVATE) {
    return `Making this ${noun} private will hide it from non-members. They won't be able to find or join it.`
  }
  if (to === Visibilities.GUEST_PUBLIC) {
    return `Members and guests will be able to find this ${noun}, join it and read its history.`
  }
  if (from === Visibilities.GUEST_PUBLIC) {
    return `Guests who haven't joined will lose access to this ${noun}. Members will still be able to find and join it.`
  }
  return `Making this ${noun} public will make it visible to all workspace members. Anyone will be able to join.`
}

function VisibilityRow({ workspaceId, stream, locked }: { workspaceId: string; stream: Stream; locked: boolean }) {
  const [pendingVisibility, setPendingVisibility] = useState<Visibility | null>(null)
  const updateMutation = useUpdateStream(workspaceId, stream.id)

  const handleConfirm = () => {
    if (!pendingVisibility) return
    updateMutation.mutate(
      { visibility: pendingVisibility },
      { onError: () => toast.error("Failed to update visibility") }
    )
    setPendingVisibility(null)
  }

  return (
    <>
      <ChoiceSetting
        setting="stream-visibility"
        variant="list"
        value={stream.visibility}
        options={VISIBILITY_ORDER.map((value) => ({
          value,
          label: VISIBILITY_LABELS[value],
          description: VISIBILITY_HINTS[value],
        }))}
        onValueChange={(value) => {
          if (value !== stream.visibility) setPendingVisibility(value)
        }}
        disabled={locked}
      />

      <ResponsiveAlertDialog open={pendingVisibility !== null} onOpenChange={() => setPendingVisibility(null)}>
        <ResponsiveAlertDialogContent>
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>Change visibility?</ResponsiveAlertDialogTitle>
            <ResponsiveAlertDialogDescription>
              {pendingVisibility &&
                visibilityChangeCopy(
                  stream.visibility,
                  pendingVisibility,
                  getStreamTypeLabel(stream.type).toLowerCase()
                )}
            </ResponsiveAlertDialogDescription>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>Cancel</ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction onClick={handleConfirm}>Confirm</ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </>
  )
}

const VISIBILITY_ORDER: readonly Visibility[] = [Visibilities.PUBLIC, Visibilities.GUEST_PUBLIC, Visibilities.PRIVATE]

/** A setting this stream has but can't change, shown with its value. */
function ReadOnlyRow({
  setting,
  value,
  description,
}: {
  setting: StreamSettingId
  value: string
  description: string
}) {
  return (
    <SettingRow
      setting={setting}
      labelFor={false}
      description={description}
      control={<SettingValue>{value}</SettingValue>}
    />
  )
}

function SlugRow({ workspaceId, stream, locked }: { workspaceId: string; stream: Stream; locked: boolean }) {
  const updateMutation = useUpdateStream(workspaceId, stream.id)
  const ids = settingIds("stream-name")
  const saved = stream.slug ?? ""
  const field = useCommittedText<HTMLInputElement>({
    saved,
    required: true,
    commit: (slug) => updateMutation.mutateAsync({ slug }),
    failureMessage: "Couldn't rename the channel",
  })
  // Availability is the server's call; a malformed slug waits for a fix.
  const save = () => {
    if (isValidSlug(field.value) || field.value === saved) void field.save()
  }

  return (
    <SettingRow
      setting="stream-name"
      labelFor={false}
      control={
        <div className={cn("space-y-1.5", SETTING_CONTROL_WIDTH)}>
          <ChannelSlugInput
            id={ids.control}
            aria-labelledby={ids.label}
            inputRef={field.fieldRef}
            workspaceId={workspaceId}
            streamId={stream.id}
            currentSlug={saved}
            value={field.value}
            onChange={field.onChange}
            onValidityChange={() => undefined}
            onBlur={save}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return
              event.preventDefault()
              save()
            }}
            indicator={<SaveIndicator state={field.state} />}
            saving={field.state.kind === "saving"}
            disabled={locked}
          />
          <SaveError state={field.state} />
        </div>
      }
    />
  )
}

function DisplayNameRow({ workspaceId, stream }: { workspaceId: string; stream: Stream }) {
  const renameStream = useRenameStream(workspaceId, stream.id, stream)
  const locked = !renameStream.canRename
  const canRegenerate = isProtectedRegenerableTitle(stream.displayName, stream.displayNameSource)
  const regeneration = useRegenerateTitle(workspaceId, {
    kind: "stream",
    stream,
    currentTitle: stream.displayName ?? "",
  })
  const ids = settingIds("stream-name")
  const errorId = `${ids.control}-error`
  const field = useCommittedText<HTMLInputElement>({
    saved: stream.displayName ?? "",
    required: true,
    commit: (name) => renameStream.rename(name),
    failureMessage: "Couldn't rename this scratchpad",
  })

  return (
    <SettingRow
      setting="stream-name"
      inactive={locked ? "Unlock this scratchpad to rename it." : undefined}
      control={
        <div className={cn("space-y-1.5", SETTING_CONTROL_WIDTH)}>
          <div className="relative">
            <Input
              ref={field.fieldRef}
              id={ids.control}
              aria-describedby={locked ? ids.reason : undefined}
              required
              aria-invalid={field.state.kind === "error" || undefined}
              aria-errormessage={field.state.kind === "error" ? errorId : undefined}
              value={field.value}
              onChange={(event) => field.onChange(event.target.value)}
              onBlur={() => void field.save()}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return
                event.preventDefault()
                void field.save()
              }}
              enterKeyHint="done"
              placeholder="Scratchpad name"
              maxLength={100}
              disabled={locked}
              className={cn("pr-9", SETTING_CONTROL_HEIGHT)}
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
              <SaveIndicator state={field.state} />
            </span>
          </div>
          <SaveError state={field.state} id={errorId} />
        </div>
      }
    >
      {canRegenerate && (
        <SettingStateAction
          action={{
            children: regeneration.isPending ? "Regenerating…" : "Regenerate title",
            disabled: locked || field.dirty || regeneration.isPending,
            onClick: () => void regeneration.regenerate().catch(() => undefined),
          }}
        >
          Won&apos;t change on its own.
        </SettingStateAction>
      )}
    </SettingRow>
  )
}

function ThreadNameRow({ workspaceId, stream }: { workspaceId: string; stream: Stream }) {
  const title = stream.displayName ?? "Thread"
  const regeneration = useRegenerateTitle(workspaceId, { kind: "stream", stream, currentTitle: title })
  const canRegenerate = !stream.e2eEnabled && isProtectedRegenerableTitle(stream.displayName, stream.displayNameSource)
  return (
    <SettingRow
      setting="stream-name"
      labelFor={false}
      description={title}
      control={
        canRegenerate && (
          <Button
            variant="outline"
            className={SETTING_CONTROL_HEIGHT}
            disabled={regeneration.isPending}
            onClick={() => void regeneration.regenerate().catch(() => undefined)}
          >
            {regeneration.isPending ? "Regenerating…" : "Regenerate title"}
          </Button>
        )
      }
    />
  )
}

function MemoryRow({ workspaceId, stream, locked }: { workspaceId: string; stream: Stream; locked: boolean }) {
  const updateMutation = useUpdateStream(workspaceId, stream.id)
  // Absent on legacy cached rows synced before this shipped; treat as auto.
  const memoryOn = (stream.memoryMode ?? MemoryModes.AUTO) === MemoryModes.AUTO

  const handleChange = (checked: boolean) => {
    const memoryMode = checked ? MemoryModes.AUTO : MemoryModes.OFF
    if (memoryMode === (stream.memoryMode ?? MemoryModes.AUTO)) return
    updateMutation.mutate({ memoryMode }, { onError: () => toast.error("Failed to update memory setting") })
  }

  return (
    <SwitchSetting
      setting="stream-memory"
      checked={memoryOn}
      onCheckedChange={handleChange}
      disabled={locked || updateMutation.isPending}
    />
  )
}

function ArchiveSection({
  workspaceId,
  stream,
  rootStream,
  currentUserId,
  locked,
}: {
  workspaceId: string
  stream: Stream
  rootStream: Stream | null
  currentUserId: string
  locked: boolean
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const archiveMutation = useArchiveStream(workspaceId)
  const unarchiveMutation = useUnarchiveStream(workspaceId)
  const canArchive = canChangeArchiveState(currentUserId, stream, rootStream)
  const isArchived = stream.archivedAt !== null
  const { ancestorArchived, sealedById } = useEffectiveArchived({ workspaceId, stream, fallbackArchived: null })
  const sealingAncestorName = useStreamName(workspaceId, sealedById ?? "", "generic")

  if (!canArchive) return null

  const handleAction = () => {
    if (stream.archivedAt) {
      unarchiveMutation.mutate(
        { streamId: stream.id, archivedAt: stream.archivedAt },
        { onError: () => toast.error("Failed to unarchive") }
      )
    } else {
      archiveMutation.mutate(stream.id, { onError: () => toast.error("Failed to archive") })
    }
    setConfirmOpen(false)
  }

  const noun = streamFallbackLabel(stream.type, "noun")
  const streamName = getStreamName(stream) ?? `this ${noun}`
  const action = isArchived ? "Unarchive" : "Archive"

  return (
    <SettingsSection section="stream-archive">
      <SettingRow
        setting="stream-archive"
        labelFor={false}
        description={
          isArchived
            ? `Restore this ${noun} to the sidebar for all members.`
            : `Hide this ${noun} from the sidebar. You can unarchive it later.`
        }
        notice={
          ancestorArchived &&
          sealedById && (
            <span data-testid="sealed-by-ancestor">
              Sealed by{" "}
              <SettingsLink to={`/w/${workspaceId}/s/${sealedById}`} replace={false}>
                {sealingAncestorName ?? "an archived parent"}
              </SettingsLink>
              . It stays read-only and out of the sidebar until that is unarchived.
            </span>
          )
        }
        control={
          <Button
            variant="outline"
            className={SETTING_CONTROL_HEIGHT}
            onClick={() => setConfirmOpen(true)}
            disabled={locked}
          >
            {action}
          </Button>
        }
      />

      <ResponsiveAlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <ResponsiveAlertDialogContent>
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {action} {streamName}?
            </ResponsiveAlertDialogTitle>
            <ResponsiveAlertDialogDescription>
              {isArchived
                ? `This ${noun} will be visible in the sidebar again.`
                : `This ${noun} will be hidden from the sidebar. You can unarchive it later.`}
            </ResponsiveAlertDialogDescription>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>Cancel</ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction onClick={handleAction}>{action}</ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </SettingsSection>
  )
}
