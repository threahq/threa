import { useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { ResponsiveSettingsNav, SETTINGS_DIALOG_LAYOUT_CLASSNAMES } from "@/components/ui/responsive-settings-nav"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { useStreamSettings, STREAM_SETTINGS_TABS, type StreamSettingsTab } from "./use-stream-settings"
import { GeneralTab } from "./general-tab"
import { CompanionTab } from "./companion-tab"
import { MembersTab } from "./members-tab"
import { streamKeys } from "@/hooks"
import {
  useWorkspaceStreams,
  useWorkspaceStreamMemberships,
  useWorkspaceUsers,
  useWorkspaceDmPeers,
} from "@/stores/workspace-store"
import { StreamTypes, type Stream, type StreamBootstrap, type NotificationLevel } from "@threa/types"
import { getStreamName, resolveDmDisplayName, streamFallbackLabel } from "@/lib/streams"

const TAB_CONFIG: Record<StreamSettingsTab, { label: string; description: string }> = {
  general: { label: "General", description: "Notifications and stream details" },
  companion: { label: "Companion", description: "AI instructions and behavior" },
  members: { label: "Members", description: "People and bot access" },
}

interface StreamSettingsDialogProps {
  workspaceId: string
}

export function StreamSettingsDialog({ workspaceId }: StreamSettingsDialogProps) {
  const { isOpen, activeTab, streamId, closeStreamSettings, setTab } = useStreamSettings()

  const queryClient = useQueryClient()
  const idbStreams = useWorkspaceStreams(workspaceId)
  const idbStreamMemberships = useWorkspaceStreamMemberships(workspaceId)

  // Cache-only observer for stream bootstrap (stays on TanStack - this is stream-level, not workspace)
  const { data: bootstrap } = useQuery({
    queryKey: streamKeys.bootstrap(workspaceId, streamId ?? ""),
    queryFn: () => queryClient.getQueryData<StreamBootstrap>(streamKeys.bootstrap(workspaceId, streamId ?? "")) ?? null,
    enabled: false,
    staleTime: Infinity,
  })

  // Get stream from stream bootstrap cache, fallback to IDB workspace streams
  const stream = streamId ? (bootstrap?.stream ?? null) : null
  const streamFromIdb = streamId ? (idbStreams.find((s) => s.id === streamId) ?? null) : null
  const resolvedStream: Stream | null = stream ?? (streamFromIdb as Stream | null)

  const currentMembership = useMemo(() => {
    if (!streamId) return null
    return idbStreamMemberships.find((m) => m.streamId === streamId) ?? null
  }, [idbStreamMemberships, streamId])

  const currentUserId = currentMembership?.memberId ?? null
  const currentNotificationLevel: NotificationLevel | null = currentMembership?.notificationLevel ?? null

  const workspaceUsers = useWorkspaceUsers(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)

  const dmDisplayName = useMemo(() => {
    if (!resolvedStream || resolvedStream.type !== StreamTypes.DM || !streamId) return null
    return resolveDmDisplayName(streamId, workspaceUsers, dmPeers) ?? resolvedStream.displayName ?? null
  }, [resolvedStream, streamId, workspaceUsers, dmPeers])

  const rootStream = useMemo(() => {
    if (!resolvedStream || resolvedStream.type !== StreamTypes.THREAD || !resolvedStream.rootStreamId) return null
    return idbStreams.find((s) => s.id === resolvedStream.rootStreamId) ?? null
  }, [resolvedStream, idbStreams])

  // Determine available tabs based on stream type
  const availableTabs: readonly StreamSettingsTab[] = useMemo(() => {
    if (!resolvedStream) return STREAM_SETTINGS_TABS
    switch (resolvedStream.type) {
      case StreamTypes.CHANNEL:
      case StreamTypes.SCRATCHPAD:
      case StreamTypes.DM:
      case StreamTypes.THREAD:
        return ["general", "companion", "members"]
      case StreamTypes.SYSTEM:
      default:
        return ["general"]
    }
  }, [resolvedStream])

  // If active tab isn't available for this stream type, fall back
  const effectiveTab = (availableTabs as readonly string[]).includes(activeTab) ? activeTab : availableTabs[0]

  // DMs carry the viewer-specific peer name in `dmDisplayName`; everything else
  // resolves through the shared helper so the title matches every other surface.
  let streamName = "Stream"
  if (resolvedStream) {
    streamName = dmDisplayName ?? getStreamName(resolvedStream) ?? streamFallbackLabel(resolvedStream.type, "generic")
  }

  return (
    <ResponsiveDialog open={isOpen} onOpenChange={(open) => !open && closeStreamSettings()}>
      <ResponsiveDialogContent
        desktopClassName="w-[min(96vw,980px)] max-w-none h-[min(720px,calc(100vh-2rem))] sm:flex flex-col overflow-hidden p-0 gap-0"
        drawerClassName="flex flex-col gap-0"
        hideCloseButton
      >
        <ResponsiveDialogHeader className="border-b px-4 py-4 sm:px-6 sm:py-5">
          <ResponsiveDialogTitle>{streamName} Settings</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="sr-only">
            Manage notifications, members, and companion settings for this stream.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        {resolvedStream && streamId && currentUserId ? (
          <Tabs
            data-slot="settings-tabs"
            value={effectiveTab}
            onValueChange={setTab}
            className={SETTINGS_DIALOG_LAYOUT_CLASSNAMES.tabs}
          >
            <div data-slot="settings-panels" className={SETTINGS_DIALOG_LAYOUT_CLASSNAMES.panels}>
              <ResponsiveSettingsNav
                tabs={availableTabs}
                items={TAB_CONFIG}
                value={effectiveTab}
                onValueChange={setTab}
              />

              <div data-slot="settings-content" className={SETTINGS_DIALOG_LAYOUT_CLASSNAMES.content}>
                <TabsContent value="general" className="mt-0">
                  <GeneralTab
                    workspaceId={workspaceId}
                    stream={resolvedStream}
                    currentUserId={currentUserId}
                    notificationLevel={currentNotificationLevel}
                    dmDisplayName={dmDisplayName}
                    rootStream={rootStream}
                  />
                </TabsContent>
                <TabsContent value="companion" className="mt-0">
                  <CompanionTab stream={resolvedStream} />
                </TabsContent>
                <TabsContent value="members" className="mt-0">
                  <MembersTab workspaceId={workspaceId} streamId={streamId} currentUserId={currentUserId} />
                </TabsContent>
              </div>
            </div>
          </Tabs>
        ) : (
          <p className="text-sm text-muted-foreground p-4">Loading stream settings...</p>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
