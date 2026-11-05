import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  DEFAULT_LINK_PREVIEW_OPEN_COUNT,
  DEFAULT_SUBAGENT_MODELS,
  StreamTypes,
  VOICE_TRANSCRIPTION_MODELS,
  WORKSPACE_PERMISSION_SCOPES,
  normalizeBoardMassBadge,
  resolveActiveStatus,
  resolveNotificationPause,
  type ActiveNotificationPause,
  type CompanionMode,
  type NotificationLevel,
  type SettingsTab,
  type StreamType,
  type UserPreferences,
  type WorkSchedule,
} from "@threahq/types"
import { integrationKeys, integrationsApi } from "@/api/integrations"
import { userApiKeyKeys, workspacesApi } from "@/api/workspaces"
import { usePreferencesOptional } from "@/contexts"
import type { StreamSettingsTab } from "@/contexts/settings-context"
import { useInheritedNotificationLevel } from "@/components/stream-settings/use-inherited-notification-level"
import { resolvePushDeviceState, type PushDeviceState } from "@/hooks/push-device-state"
import { useCachedStreamBootstrap } from "@/hooks/use-cached-stream-bootstrap"
import { useCompanionRoster } from "@/hooks/use-companion-roster"
import { useDefaultCompanionPersona } from "@/hooks/use-default-companion-persona"
import { useOverriddenFeatureFlags } from "@/hooks/use-feature-flags"
import { usePushNotifications } from "@/hooks/use-push-notifications"
import { useCachedWorkspaceBootstrap, useCurrentWorkspaceUser, useViewerPermissions } from "@/hooks/use-workspaces"
import { useEffectiveWorkSchedule, useWorkspaceDefaultWorkSchedule } from "@/hooks/use-work-schedule"
import { formatFutureTime } from "@/lib/dates"
import { formatNotificationPauseLabel } from "@/lib/status"
import { BOARD_LENS_DEFS } from "@/lib/board/lens-defs"
import { parseLensParam } from "@/components/board/board-filter-params"
import {
  SHORTCUT_ACTIONS,
  formatActionBinding,
  getEffectiveKeyBinding,
  isCustomBinding,
} from "@/lib/keyboard-shortcuts"
import { hasPermission } from "@/lib/permissions"
import { useCallPrefs, type CallPrefs } from "@/stores/call-prefs-store"
import { useE2eSession, type E2eSessionStatus } from "@/stores/e2e-session-store"
import { useStreamFromStore } from "@/stores/stream-store"
import { resolveCompanionSelection } from "@/components/stream-settings/companion-agent-select"
import {
  isPickableUser,
  useWorkspaceBots,
  useWorkspaceFromStore,
  useWorkspaceStreamMemberships,
  useWorkspaceUsers,
} from "@/stores/workspace-store"
import {
  SETTING_CHOICE_LABELS,
  SHORTCUT_ANCHOR_PREFIX,
  lowerFirst,
  streamNotifyLabel,
  upperFirst,
  type AnySettingId,
} from "./settings-registry"
import { formatWorkScheduleLine } from "./work-schedule-editor"
import { dataSharingUnavailable, effectiveDataSharing } from "./privacy-settings"
import { pushButtonsSummary, pushButtonsUnavailable, supportsNotificationActions } from "./push-actions-section"
import { INSTALLATION_OFF } from "./setting-primitives"
import { subagentModelsState } from "./subagent-models-settings"

export interface SettingsSummaries {
  /** A setting's or shortcut's current value as it reads, beside search results and changed rows. */
  values: Partial<Record<AnySettingId | `${typeof SHORTCUT_ANCHOR_PREFIX}${string}`, string>>
  /** A page's key current values, for the overview and the phone index. */
  pages: Partial<Record<SettingsTab, string>>
  /** The same for the stream in view's pages. */
  streamPages: Partial<Record<StreamSettingsTab, string>>
}

export interface SettingsSummaryInput {
  preferences: UserPreferences | null | undefined
  pause: ActiveNotificationPause | null
  pushDevice: PushDeviceState
  /** Whether this browser shows buttons on a push. */
  pushButtonsSupported: boolean
  /** Whether this installation collects analytics; undefined until the workspace bootstrap is cached. */
  analyticsConfigured: boolean | undefined
  /** Your name and active status text. */
  profile: { name: string; status: string | null } | null
  workspaceName: string | undefined
  /**
   * Active GitHub accounts and Linear workspaces, and whether this installation
   * offers each; undefined until known, or for a viewer who can't see them.
   */
  integrations: Record<"github" | "linear", { connected: number; available: boolean }> | undefined
  /** Your unrevoked API keys; undefined until known. */
  apiKeys: number | undefined
  personalBots: number
  sharedBots: number
  /** Features turned on for you early. */
  earlyFeatures: number
  /** The stream in view's members; undefined until its bootstrap is cached. */
  streamMembers: number | undefined
  encryption: E2eSessionStatus
  callPrefs: CallPrefs
  ownHours: WorkSchedule
  workspaceHours: WorkSchedule
  defaultAgent: string | undefined
  workspaceDefaultAgent: string | undefined
  memberCount: number
  /** Models the workspace lets agents start helpers on. */
  workspaceSubagentModels: readonly string[]
  /** The stream in view's own level; undefined when the viewer isn't a member of one. */
  stream:
    | { level: Parameters<typeof streamNotifyLabel>[0]; type: StreamType; inheritedLevel: NotificationLevel }
    | undefined
  /** The stream in view's name, as its settings show it. */
  streamName: string | undefined
  /** Whether the agent replies in the stream in view, and which agent; the name once the roster is known. */
  streamAgent: { mode: CompanionMode; name: string | undefined } | undefined
  now: Date
}

/** "Europe/Stockholm" → "Stockholm". */
function timezoneCity(timezone: string): string {
  return (timezone.split("/").pop() ?? timezone).replace(/_/g, " ")
}

function onOff(on: boolean): string {
  return on ? "On" : "Off"
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function lineFoldSummary(enabled: boolean, threshold: number): string {
  if (!enabled) return "Never"
  return threshold === 0 ? "Always" : `Taller than ${count(threshold, "line", "lines")}`
}

function providerSummary({ connected, available }: { connected: number; available: boolean }, active: string): string {
  if (!available) return INSTALLATION_OFF.value
  return connected === 0 ? "Not connected" : active
}

function countOrNone(n: number, one: string, many: string): string {
  return n === 0 ? `No ${many}` : count(n, one, many)
}

const PUSH_DEVICE_VALUES: Record<PushDeviceState, string> = {
  on: "On for this device",
  subscribing: "Turning on for this device",
  off: "Off for this device",
  blocked: "Blocked on this device",
  unsupported: "Not supported on this device",
  "server-off": INSTALLATION_OFF.value,
  error: "Couldn't turn on for this device",
}

function linkPreviewsPhrase(open: number | "all"): string {
  if (open === "all") return "All previews open"
  if (open === 0) return "Previews collapsed"
  return open === 1 ? "First preview opens" : `First ${open} previews open`
}

const ENCRYPTION_VALUES: Partial<Record<E2eSessionStatus, string>> = {
  "no-key": "Encrypted scratchpads: not set up",
  locked: "Encrypted scratchpads: locked",
  unlocking: "Encrypted scratchpads: locked",
  unlocked: "Encrypted scratchpads: unlocked",
}

const ENCRYPTION_PAGE_VALUES: Partial<Record<E2eSessionStatus, string>> = {
  "no-key": "No encryption",
  locked: "Encryption locked",
  unlocking: "Encryption locked",
  unlocked: "Encryption unlocked",
}

/**
 * The one owner of how current values read before a page is opened: the
 * overview's page lines, values beside search results and the palette, and
 * the changed-from-default rows.
 */
export function summarizeSettings(input: SettingsSummaryInput): SettingsSummaries {
  const values: SettingsSummaries["values"] = {}
  const pages: SettingsSummaries["pages"] = {}
  const streamPages: SettingsSummaries["streamPages"] = {}
  const p = input.preferences
  const timeFormat = p?.timeFormat ?? "24h"

  values["working-hours"] = formatWorkScheduleLine(input.ownHours, timeFormat)
  values["default-working-hours"] = formatWorkScheduleLine(input.workspaceHours, timeFormat)
  pages["workspace-defaults"] = `Working hours ${values["default-working-hours"]}`

  const pause = input.pause
  values.pause = pause ? formatNotificationPauseLabel(pause, input.now) : "Not paused"
  values["push-device"] = PUSH_DEVICE_VALUES[input.pushDevice]

  const encryption = ENCRYPTION_VALUES[input.encryption]
  if (encryption) values.encryption = encryption

  values["call-mirror"] = SETTING_CHOICE_LABELS["call-mirror"][input.callPrefs.selfMirror]
  values["call-layout"] = SETTING_CHOICE_LABELS["call-layout"][input.callPrefs.layout]
  values["call-desktop-video"] = SETTING_CHOICE_LABELS["call-desktop-video"][input.callPrefs.desktopCallSurface]

  if (p) {
    values.theme = SETTING_CHOICE_LABELS.theme[p.theme]
    values.density = SETTING_CHOICE_LABELS.density[p.messageDisplay]
    values["font-size"] = SETTING_CHOICE_LABELS["font-size"][p.accessibility.fontSize]
    values["font-family"] = SETTING_CHOICE_LABELS["font-family"][p.accessibility.fontFamily]
    values["reduce-motion"] = onOff(p.accessibility.reducedMotion)
    values["high-contrast"] = onOff(p.accessibility.highContrast)
    pages.appearance = `${values.theme} · ${lowerFirst(values.density)}`

    values["notification-level"] = SETTING_CHOICE_LABELS["notification-level"][p.notificationLevel]
    values["quiet-hours"] = p.quietOutsideWorkingHours ? "Quiet outside working hours" : "Off"
    values["push-buttons"] =
      pushButtonsUnavailable(input.pushButtonsSupported, p.notificationLevel)?.value ??
      pushButtonsSummary(p.pushActions)
    const holds = [
      pause && (pause.until ? `paused until ${formatFutureTime(new Date(pause.until), input.now)}` : "paused"),
      p.quietOutsideWorkingHours && "quiet outside working hours",
      lowerFirst(values["push-device"]),
    ].filter(Boolean)
    // With push off for the whole installation the level promises nothing, so the line says only that.
    pages.notifications =
      input.pushDevice === "server-off"
        ? "Push is off on this installation"
        : [values["notification-level"], ...holds].join(" · ")

    const previews =
      p.linkPreviewDefault === "collapsed" ? 0 : (p.linkPreviewOpenCount ?? DEFAULT_LINK_PREVIEW_OPEN_COUNT)
    values["link-preview-count"] = linkPreviewsPhrase(previews)
    const typeOverrides = Object.keys(p.linkPreviewTypeOverrides ?? {}).length
    values["link-preview-types"] = typeOverrides === 0 ? "Same for every type" : count(typeOverrides, "type", "types")
    values["message-collapse"] = p.messageCollapseEnabled ? "Long messages collapse" : "Long messages show in full"
    values["message-collapse-at"] = `${p.messageCollapseAtHeight} px`
    values["message-collapse-to"] = `${p.messageCollapseToHeight} px`
    values["code-collapse"] = lineFoldSummary(p.codeBlockCollapseEnabled, p.codeBlockCollapseThreshold)
    values["code-wrap"] = SETTING_CHOICE_LABELS["code-wrap"][p.codeBlockWrap]
    const wrapOverrides = Object.keys(p.codeBlockWrapOverrides ?? {}).length
    values["code-wrap-languages"] = wrapOverrides === 0 ? "None" : count(wrapOverrides, "language", "languages")
    values["quote-collapse"] = lineFoldSummary(p.blockquoteCollapseEnabled, p.blockquoteCollapseThreshold)
    values["unread-landing"] = SETTING_CHOICE_LABELS["unread-landing"][p.unreadOpenPosition]
    pages.messages = `${linkPreviewsPhrase(previews)} · long messages ${p.messageCollapseEnabled ? "collapse" : "in full"}`

    values.settling = SETTING_CHOICE_LABELS.settling[p.inboxClearMode]
    values["label-move"] = SETTING_CHOICE_LABELS["label-move"][p.labelRemoveOnMove]
    values["board-home"] = p.boardDefaultViewId
      ? "A saved view"
      : BOARD_LENS_DEFS[parseLensParam(p.boardDefaultLens)].label
    values["board-card-collapse"] = onOff(p.boardCardCollapseEnabled)
    values["board-card-collapse-at"] = `${p.boardCardCollapseAtHeight} px`
    values["board-card-collapse-to"] = `${p.boardCardCollapseToHeight} px`
    values["board-full-tail"] = String(p.boardFullTailCount)
    values["board-ledger-rows"] = String(p.boardLedgerRows)
    values["board-lead-line"] = count(p.boardLeadLineLength, "character", "characters")
    values["board-head-badge"] = SETTING_CHOICE_LABELS["board-head-badge"][normalizeBoardMassBadge(p.boardMassBadge)]
    pages.inbox = values.settling

    values["send-key"] = SETTING_CHOICE_LABELS["send-key"][p.messageSendMode]
    values["send-side"] = SETTING_CHOICE_LABELS["send-side"][p.accessibility.composerActionSide]
    values["file-insert"] = onOff(p.mobileInlineAttachments)
    const rebound = SHORTCUT_ACTIONS.filter((action) => isCustomBinding(action, p.keyboardShortcuts ?? {})).length
    values.shortcuts = rebound === 0 ? "Defaults" : count(rebound, "changed", "changed")
    pages.keyboard = `Enter: ${values["send-key"].toLowerCase()} · ${values["send-side"].toLowerCase()}`

    values.timezone = timezoneCity(p.timezone)
    values["time-format"] = SETTING_CHOICE_LABELS["time-format"][p.timeFormat]
    values["date-format"] = p.dateFormat
    pages.datetime = `${values.timezone} · ${values["time-format"]} · ${values["working-hours"]}`

    values["ai-instructions"] = p.scratchpadCustomPrompt?.trim() ? "Set" : "None"
    const models = subagentModelsState(input.workspaceSubagentModels, p.subagentModels)
    if (!models.hasSubset) values["subagent-models"] = `Workspace models · ${models.selected.length}`
    else if (models.delegationOff) values["subagent-models"] = "None allowed"
    else values["subagent-models"] = count(models.selected.length, "model", "models")

    const model = VOICE_TRANSCRIPTION_MODELS.find((option) => option.id === p.voiceTranscriptionModel)
    values["dictation-model"] = model?.name ?? "Automatic"
    values["dictation-polish"] = SETTING_CHOICE_LABELS["dictation-polish"][p.voicePolishLevel]
    values["steering-words"] = count(p.voiceSteeringWords.length, "word", "words")
    pages.voice = `Dictation: ${lowerFirst(values["dictation-polish"])} · ${values["call-layout"].toLowerCase()} layout`

    if (input.analyticsConfigured !== undefined) {
      const sharing = effectiveDataSharing(input.analyticsConfigured, p)
      const unavailable = dataSharingUnavailable(input.analyticsConfigured, sharing.granted)
      values["crash-reports"] = unavailable.crashReports?.value ?? onOff(sharing.granted)
      values["session-recording"] = unavailable.sessionRecording?.value ?? onOff(sharing.replayOptIn)
    }
    const deviceShared = p.shareDeviceWithAgents !== false
    values["device-sharing"] = SETTING_CHOICE_LABELS["device-sharing"][deviceShared ? "on" : "off"]
    values.diagnostics = onOff(p.performanceDiagnosticsOptIn)
    const deviceSharing = `${deviceShared ? "device" : "device not"} shared with agents`
    const encryptionPage = ENCRYPTION_PAGE_VALUES[input.encryption]
    pages.privacy = encryptionPage ? `${encryptionPage} · ${deviceSharing}` : upperFirst(deviceSharing)
  }

  if (input.defaultAgent) {
    values["default-companion"] = input.defaultAgent
    pages.ai = `Your default agent: ${input.defaultAgent}`
  }
  if (input.workspaceDefaultAgent) {
    values["workspace-default-companion"] = input.workspaceDefaultAgent
    pages["workspace-ai"] = `Workspace default agent: ${input.workspaceDefaultAgent}`
  }
  values["workspace-subagent-models"] = count(input.workspaceSubagentModels.length, "model", "models")
  if (input.memberCount > 0) pages.members = count(input.memberCount, "member", "members")

  for (const action of SHORTCUT_ACTIONS) {
    const binding = getEffectiveKeyBinding(action.id, p?.keyboardShortcuts)
    values[`${SHORTCUT_ANCHOR_PREFIX}${action.id}`] = binding ? formatActionBinding(action.id, binding) : "No shortcut"
  }

  if (input.profile) {
    pages.profile = [input.profile.name, input.profile.status].filter(Boolean).join(" · ")
  }
  if (input.workspaceName) {
    values["workspace-name"] = input.workspaceName
    pages.workspace = input.workspaceName
  }
  const integrations = input.integrations
  if (integrations) {
    const { github, linear } = integrations
    values["github-integration"] = providerSummary(
      github,
      `${count(github.connected, "account", "accounts")} connected`
    )
    values["linear-integration"] = providerSummary(linear, "Connected")
    const connected = github.connected + linear.connected
    if (!github.available && !linear.available) pages.integrations = INSTALLATION_OFF.value
    else pages.integrations = connected === 0 ? "None connected" : `${connected} connected`
  }
  pages.bots = countOrNone(input.sharedBots, "bot", "bots")
  const bots = countOrNone(input.personalBots, "bot", "bots")
  pages.developer =
    input.apiKeys === undefined ? bots : `${countOrNone(input.apiKeys, "API key", "API keys")} · ${lowerFirst(bots)}`
  if (input.earlyFeatures > 0) pages["early-access"] = `${count(input.earlyFeatures, "feature", "features")} on`

  if (input.stream) {
    values["stream-notifications"] = streamNotifyLabel(
      input.stream.level,
      input.stream.type,
      input.stream.inheritedLevel
    )
    streamPages.general = `Notify: ${lowerFirst(values["stream-notifications"])}`
  }
  if (input.streamName) values["stream-name"] = input.streamName
  const agent = input.streamAgent
  if (agent) {
    values["stream-replies"] = SETTING_CHOICE_LABELS["stream-replies"][agent.mode]
    if (agent.name) values["stream-agent"] = agent.name
    streamPages.companion = `${agent.name ?? "Agent"} ${agent.mode === "on" ? "replies" : "stays quiet"}`
  }
  if (input.streamMembers !== undefined) streamPages.members = count(input.streamMembers, "member", "members")
  return { values, pages, streamPages }
}

interface StreamSummaryRow {
  companionMode: CompanionMode
  companionPersonaId: string | null
  e2eEnabled?: boolean
  parentStreamId: string | null
}

const pickSummaryRow = (row: StreamSummaryRow): StreamSummaryRow => ({
  companionMode: row.companionMode,
  companionPersonaId: row.companionPersonaId,
  e2eEnabled: row.e2eEnabled,
  parentStreamId: row.parentStreamId,
})

/**
 * Current values worth seeing before opening a page; `stream` adds the
 * stream's own. `overview` also fetches the counts only the overview shows,
 * such as API keys and connected services.
 */
export function useSettingsSummaries(
  workspaceId: string,
  stream: { streamId: string; type: StreamType; name?: string } | null = null,
  { overview = false }: { overview?: boolean } = {}
): SettingsSummaries {
  const preferences = usePreferencesOptional()?.preferences
  const agents = useDefaultCompanionPersona(workspaceId)
  const users = useWorkspaceUsers(workspaceId)
  const memberCount = users.filter(isPickableUser).length
  const memberships = useWorkspaceStreamMemberships(workspaceId)
  const streamId = stream?.streamId
  const streamType = stream?.type
  const membership = streamId ? memberships.find((row) => row.streamId === streamId) : undefined
  const streamLevel = membership ? (membership.notificationLevel ?? "default") : undefined
  const streamName = stream?.name
  const streamBootstrap = useCachedStreamBootstrap(workspaceId, streamId)
  const streamMembers = streamBootstrap?.members.length
  // Archived streams aren't in the store; their own bootstrap holds the row.
  const streamRow = useStreamFromStore(workspaceId, streamId, pickSummaryRow) ?? streamBootstrap?.stream
  const inheritedLevel = useInheritedNotificationLevel(workspaceId, {
    id: streamId,
    type: streamType ?? StreamTypes.CHANNEL,
    parentStreamId: streamRow?.parentStreamId ?? null,
  }).level
  const roster = useCompanionRoster(workspaceId)
  const streamAgentMode = streamRow?.companionMode
  // Until the roster hydrates the agent is unknown; encrypted streams always run Ariadne.
  const streamAgentName =
    streamRow && (streamRow.e2eEnabled || roster.length > 0)
      ? resolveCompanionSelection(roster, streamRow.companionPersonaId).companionName
      : undefined
  const currentUser = useCurrentWorkspaceUser(workspaceId)
  const pushDevice = resolvePushDeviceState(usePushNotifications(workspaceId))
  const analyticsConfigured =
    useCachedWorkspaceBootstrap(workspaceId, (bootstrap) => Boolean(bootstrap.analytics)) ?? undefined
  const encryption = useE2eSession(workspaceId, currentUser?.id ?? "").status
  const callPrefs = useCallPrefs()
  const ownHours = useEffectiveWorkSchedule(workspaceId)
  const workspaceHours = useWorkspaceDefaultWorkSchedule(workspaceId)
  const activePause = currentUser ? resolveNotificationPause(currentUser) : null
  const pauseUntil = activePause ? activePause.until : undefined
  const pauseSource = activePause?.source
  const workspaceSubagentModels =
    useCachedWorkspaceBootstrap(workspaceId, (bootstrap) => bootstrap.workspaceSettings?.subagentModels) ??
    DEFAULT_SUBAGENT_MODELS
  const workspaceName = useWorkspaceFromStore(workspaceId)?.name
  const profileName = currentUser?.name
  const profileStatus = currentUser ? (resolveActiveStatus(currentUser)?.text ?? null) : null
  const bots = useWorkspaceBots(workspaceId).filter((bot) => !bot.archivedAt)
  const sharedBots = bots.filter((bot) => bot.type === "shared").length
  const personalBots = bots.filter((bot) => bot.type === "personal").length
  const earlyFeatures = useOverriddenFeatureFlags(workspaceId).length
  const isAdmin = hasPermission(useViewerPermissions(workspaceId), WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)
  const apiKeys = useQuery({
    queryKey: userApiKeyKeys.list(workspaceId),
    queryFn: () => workspacesApi.listUserApiKeys(workspaceId),
    enabled: overview,
    select: (keys) => keys.filter((key) => !key.revokedAt).length,
  }).data
  const github = useQuery({
    queryKey: integrationKeys.provider(workspaceId, "github"),
    queryFn: () => integrationsApi.getGithub(workspaceId),
    enabled: overview && isAdmin,
  }).data
  const linear = useQuery({
    queryKey: integrationKeys.provider(workspaceId, "linear"),
    queryFn: () => integrationsApi.getLinear(workspaceId),
    enabled: overview && isAdmin,
  }).data
  const integrationsKnown = github !== undefined && linear !== undefined
  const githubAvailable = !!github?.configured
  const githubConnected = github?.integrations.filter((integration) => integration.status === "active").length ?? 0
  const linearAvailable = !!linear?.configured
  const linearConnected = linear?.integration?.status === "active" ? 1 : 0

  return useMemo(
    () =>
      summarizeSettings({
        preferences,
        pause: pauseUntil === undefined || !pauseSource ? null : { until: pauseUntil, source: pauseSource },
        pushDevice,
        pushButtonsSupported: supportsNotificationActions(),
        analyticsConfigured,
        profile: profileName ? { name: profileName, status: profileStatus } : null,
        workspaceName,
        integrations: integrationsKnown
          ? {
              github: { connected: githubConnected, available: githubAvailable },
              linear: { connected: linearConnected, available: linearAvailable },
            }
          : undefined,
        apiKeys,
        personalBots,
        sharedBots,
        earlyFeatures,
        streamMembers,
        encryption,
        callPrefs,
        ownHours,
        workspaceHours,
        defaultAgent: agents.effectiveDefault?.name,
        workspaceDefaultAgent: agents.workspaceDefault?.name,
        memberCount,
        workspaceSubagentModels,
        stream: streamLevel && streamType ? { level: streamLevel, type: streamType, inheritedLevel } : undefined,
        streamName,
        streamAgent: streamAgentMode ? { mode: streamAgentMode, name: streamAgentName } : undefined,
        now: new Date(),
      }),
    [
      preferences,
      pauseUntil,
      pauseSource,
      pushDevice,
      analyticsConfigured,
      profileName,
      profileStatus,
      workspaceName,
      integrationsKnown,
      githubAvailable,
      githubConnected,
      linearAvailable,
      linearConnected,
      apiKeys,
      personalBots,
      sharedBots,
      earlyFeatures,
      streamMembers,
      encryption,
      callPrefs,
      ownHours,
      workspaceHours,
      agents.effectiveDefault?.name,
      agents.workspaceDefault?.name,
      memberCount,
      workspaceSubagentModels,
      streamLevel,
      streamType,
      inheritedLevel,
      streamName,
      streamAgentMode,
      streamAgentName,
    ]
  )
}
