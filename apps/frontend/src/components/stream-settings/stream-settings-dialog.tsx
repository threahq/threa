import { useMemo } from "react"
import { SettingsPageSkeleton } from "@/components/settings/settings-shell"
import type { StreamSettingsTab } from "@/contexts/settings-context"
import { GeneralTab } from "./general-tab"
import { CompanionTab } from "./companion-tab"
import { MembersTab } from "./members-tab"
import { ConnectTab } from "./connect-tab"
import { useCachedStreamBootstrap } from "@/hooks/use-cached-stream-bootstrap"
import {
  useWorkspaceStreams,
  useWorkspaceStreamMemberships,
  useWorkspaceUsers,
  useWorkspaceDmPeers,
} from "@/stores/workspace-store"
import { StreamTypes, type Stream, type NotificationLevel } from "@threahq/types"
import { resolveDmDisplayName } from "@/lib/streams"
import { useCurrentWorkspaceUserId } from "@/hooks/use-current-workspace-user-id"

interface StreamSettingsPageProps {
  workspaceId: string
  streamId: string
  tab: StreamSettingsTab
  /** Invite links created this session; they exist only in their create response. */
  inviteLinks: ReadonlyMap<string, string>
  onInviteLinkCreated: (connectionId: string, url: string) => void
}

/** One of a stream's pages, as the settings window shows it. */
export function StreamSettingsPage({
  workspaceId,
  streamId,
  tab,
  inviteLinks,
  onInviteLinkCreated,
}: StreamSettingsPageProps) {
  const idbStreams = useWorkspaceStreams(workspaceId)
  const idbStreamMemberships = useWorkspaceStreamMemberships(workspaceId)

  const bootstrap = useCachedStreamBootstrap(workspaceId, streamId)

  // Get stream from stream bootstrap cache, fallback to IDB workspace streams
  const stream = bootstrap?.stream ?? null
  const streamFromIdb = idbStreams.find((s) => s.id === streamId) ?? null
  // Bootstrap keeps E2E displayName null by design; the workspace-store row is
  // the memory-only decrypted overlay. Prefer that title in the window without
  // ever persisting it, so encrypted title actions remain reachable while unlocked.
  let resolvedStream: Stream | null = stream ?? (streamFromIdb as Stream | null)
  if (stream?.e2eEnabled && streamFromIdb?.displayName) {
    resolvedStream = { ...stream, displayName: streamFromIdb.displayName }
  }

  // The viewer's identity must not come from the membership row: memberships
  // aren't bootstrapped for archived streams, so gating the window on one left
  // an archived stream (its only unarchive affordance) stuck on the loading
  // state after a reload. Membership is only the notification-level source.
  const currentUserId = useCurrentWorkspaceUserId(workspaceId)
  const currentNotificationLevel: NotificationLevel | null =
    idbStreamMemberships.find((m) => m.streamId === streamId)?.notificationLevel ?? null

  const workspaceUsers = useWorkspaceUsers(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)

  const dmDisplayName = useMemo(() => {
    if (!resolvedStream || resolvedStream.type !== StreamTypes.DM) return null
    return resolveDmDisplayName(streamId, workspaceUsers, dmPeers) ?? resolvedStream.displayName ?? null
  }, [resolvedStream, streamId, workspaceUsers, dmPeers])

  const rootStream = useMemo(() => {
    if (!resolvedStream || resolvedStream.type !== StreamTypes.THREAD || !resolvedStream.rootStreamId) return null
    return idbStreams.find((s) => s.id === resolvedStream.rootStreamId) ?? null
  }, [resolvedStream, idbStreams])

  if (!resolvedStream || !currentUserId) return <SettingsPageSkeleton />

  switch (tab) {
    case "general":
      return (
        <GeneralTab
          workspaceId={workspaceId}
          stream={resolvedStream}
          currentUserId={currentUserId}
          notificationLevel={currentNotificationLevel}
          dmDisplayName={dmDisplayName}
          rootStream={rootStream}
        />
      )
    case "companion":
      return (
        <CompanionTab
          workspaceId={workspaceId}
          stream={resolvedStream}
          allowedToolCategories={bootstrap?.allowedToolCategories ?? null}
          configuredToolCategories={bootstrap?.configuredToolCategories}
          canManageToolPolicy={
            resolvedStream.type === StreamTypes.SCRATCHPAD && resolvedStream.createdBy === currentUserId
          }
          rootStream={rootStream}
        />
      )
    case "members":
      return <MembersTab workspaceId={workspaceId} streamId={streamId} currentUserId={currentUserId} />
    case "connect":
      return (
        <ConnectTab
          workspaceId={workspaceId}
          stream={resolvedStream}
          inviteLinks={inviteLinks}
          onInviteLinkCreated={onInviteLinkCreated}
        />
      )
  }
}
