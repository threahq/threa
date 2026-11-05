import { useMemo } from "react"
import { useIsFetching } from "@tanstack/react-query"
import { useMatch } from "react-router-dom"
import { WORKSPACE_PERMISSION_SCOPES, type StreamType } from "@threahq/types"
import { useFeatureFlag, isDraftId } from "@/hooks"
import { useCachedStreamBootstrap } from "@/hooks/use-cached-stream-bootstrap"
import { useStreamName } from "@/hooks/use-stream-name"
import { streamKeys } from "@/hooks/use-streams"
import { useViewerPermissions } from "@/hooks/use-workspaces"
import { hasPermission } from "@/lib/permissions"
import { streamLabel } from "@/lib/streams"
import { useStreamFromStore } from "@/stores/stream-store"
import { useWorkspaceStreamsLoaded, type CachedStream } from "@/stores/workspace-store"
import { STREAM_SETTINGS_TABS, type StreamSettingsTab } from "@/contexts/settings-context"
import { streamSettingsTabs } from "./settings-registry"

export interface StreamSettingsScope {
  streamId: string
  name: string
  type: StreamType
  tabs: readonly StreamSettingsTab[]
}

const pickShape = (row: Pick<CachedStream, "type" | "parentStreamId">) => ({
  type: row.type,
  parentStreamId: row.parentStreamId,
})

/** The saved stream the route shows, if any; a draft has no settings yet. */
export function useRouteStreamId(): string | null {
  const streamId = useMatch("/w/:workspaceId/s/:streamId/*")?.params.streamId ?? null
  return streamId && !isDraftId(streamId) ? streamId : null
}

/** Whether this viewer may share streams with other workspaces: the Sharing page. */
export function useCanConnectStreams(workspaceId: string): boolean {
  const permissions = useViewerPermissions(workspaceId)
  return (
    useFeatureFlag(workspaceId, "streamConnections") === "on" &&
    hasPermission(permissions, WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)
  )
}

/** Stream pages some stream of this viewer's can show: search offers their settings with no stream in view. */
export function useAnyStreamSettingsTabs(workspaceId: string): readonly StreamSettingsTab[] {
  const canConnect = useCanConnectStreams(workspaceId)
  return useMemo(() => STREAM_SETTINGS_TABS.filter((tab) => tab !== "connect" || canConnect), [canConnect])
}

/**
 * The stream whose pages join the settings window, such as the one it opened
 * from; null without one, for drafts and until the stream is cached. Archived
 * streams aren't in the workspace store, so its own bootstrap is the fallback.
 */
export function useStreamSettingsScope(
  workspaceId: string,
  currentStreamId: string | null | undefined
): StreamSettingsScope | null {
  const streamId = currentStreamId && !isDraftId(currentStreamId) ? currentStreamId : undefined
  const stored = useStreamFromStore(workspaceId, streamId, pickShape)
  const bootstrapStream = useCachedStreamBootstrap(workspaceId, streamId)?.stream
  const shape = stored ?? (bootstrapStream ? pickShape(bootstrapStream) : undefined)
  const storedName = useStreamName(workspaceId, streamId ?? "")
  const name = storedName ?? (bootstrapStream ? streamLabel(bootstrapStream) : null)
  const canConnect = useCanConnectStreams(workspaceId)
  const type = shape?.type
  const parentStreamId = shape?.parentStreamId ?? null
  return useMemo(() => {
    if (!streamId || !type) return null
    return {
      streamId,
      name: name ?? "This stream",
      type,
      tabs: streamSettingsTabs({ type, parentStreamId }, canConnect),
    }
  }, [streamId, name, type, parentStreamId, canConnect])
}

/**
 * Whether a stream `useStreamSettingsScope` hasn't found may still turn up:
 * the workspace's streams or the stream's own bootstrap are loading. Once both
 * settle, a stream still missing is gone or was never this viewer's.
 */
export function useStreamSettingsScopeLoading(workspaceId: string, streamId: string | null): boolean {
  const streamsLoaded = useWorkspaceStreamsLoaded(workspaceId)
  const bootstrapFetches = useIsFetching({ queryKey: streamKeys.bootstrap(workspaceId, streamId ?? "") })
  return streamId !== null && (!streamsLoaded || bootstrapFetches > 0)
}
