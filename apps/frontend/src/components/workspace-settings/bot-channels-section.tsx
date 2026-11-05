import { useMemo } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { botsApi } from "@/api/bots"
import { StreamTypes } from "@threahq/types"
import { useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { SearchableSelect } from "@/components/ui/searchable-select"
import {
  SettingAddButton,
  SettingEmptyNote,
  SettingFieldError,
  SettingRemoveButton,
  SettingRow,
  SettingBadge,
  SETTING_ITEM_DIVIDERS,
} from "@/components/settings/setting-primitives"
import { VISIBILITY_LABELS } from "@/lib/stream-visuals"
import { Hash } from "lucide-react"

interface BotChannelsSectionProps {
  workspaceId: string
  botId: string
  isArchived: boolean
}

export function BotChannelsSection({ workspaceId, botId, isArchived }: BotChannelsSectionProps) {
  const queryClient = useQueryClient()

  const grantsQueryKey = ["bot-stream-grants", workspaceId, botId]
  const { data: streamGrants = [] } = useQuery({
    queryKey: grantsQueryKey,
    queryFn: () => botsApi.listStreamGrants(workspaceId, botId),
  })

  const wsBootstrap = useCachedWorkspaceBootstrap(workspaceId)

  const grantStreamMutation = useMutation({
    mutationFn: (streamId: string) => botsApi.grantStreamAccess(workspaceId, botId, streamId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: grantsQueryKey }),
  })

  const revokeStreamMutation = useMutation({
    mutationFn: (streamId: string) => botsApi.revokeStreamAccess(workspaceId, botId, streamId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: grantsQueryKey }),
  })

  const grantedStreamIds = useMemo(() => new Set(streamGrants.map((g) => g.streamId)), [streamGrants])

  const availableChannels = useMemo(() => {
    if (!wsBootstrap?.streams) return []
    return wsBootstrap.streams
      .filter((s) => s.type === StreamTypes.CHANNEL && !s.archivedAt && !grantedStreamIds.has(s.id))
      .sort((a, b) => (a.slug ?? a.displayName ?? "").localeCompare(b.slug ?? b.displayName ?? ""))
  }, [wsBootstrap, grantedStreamIds])

  const grantedStreams = useMemo(() => {
    if (!wsBootstrap?.streams) return []
    const enriched = streamGrants
      .map((g) => {
        const stream = wsBootstrap.streams.find((s) => s.id === g.streamId)
        return stream ? { ...g, slug: stream.slug, displayName: stream.displayName } : null
      })
      .filter(Boolean) as Array<{
      streamId: string
      grantedBy: string
      grantedAt: string
      slug: string | null
      displayName: string | null
    }>
    return enriched.sort((a, b) => (a.slug ?? a.displayName ?? "").localeCompare(b.slug ?? b.displayName ?? ""))
  }, [streamGrants, wsBootstrap])

  const channelName = (grant: { slug: string | null; displayName: string | null; streamId: string }) =>
    grant.slug ?? grant.displayName ?? grant.streamId

  return (
    <SettingRow
      label="Channel access"
      description="Bots can access all public channels. Grant access to private ones here."
      control={
        !isArchived &&
        availableChannels.length > 0 && (
          <SearchableSelect
            items={availableChannels}
            value={null}
            onChange={(stream) => grantStreamMutation.mutate(stream.id)}
            getKey={(s) => s.id}
            getKeywords={(s) =>
              [s.slug ?? "", s.slug ? `#${s.slug}` : "", s.displayName ?? ""].filter(Boolean) as string[]
            }
            searchPlaceholder="Search channels"
            emptyMessage="No matching channels"
            align="end"
            contentClassName="w-72"
            trigger={<SettingAddButton disabled={grantStreamMutation.isPending}>Grant channel access</SettingAddButton>}
            renderItem={(stream) => (
              <>
                <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate text-sm">{stream.slug ?? stream.displayName}</span>
                <SettingBadge className="ml-auto">{VISIBILITY_LABELS[stream.visibility]}</SettingBadge>
              </>
            )}
          />
        )
      }
    >
      {grantedStreams.length > 0 ? (
        <ul className={SETTING_ITEM_DIVIDERS}>
          {grantedStreams.map((grant) => (
            <li key={grant.streamId} className="flex min-h-11 items-center justify-between gap-2 py-2">
              <span className="flex min-w-0 items-center gap-2">
                <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate text-sm font-medium">{channelName(grant)}</span>
              </span>
              {!isArchived && (
                <SettingRemoveButton
                  label={`Remove access to ${grant.slug ? `#${grant.slug}` : (grant.displayName ?? "this channel")}`}
                  onClick={() => revokeStreamMutation.mutate(grant.streamId)}
                  disabled={revokeStreamMutation.isPending}
                />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <SettingEmptyNote>No private channels yet.</SettingEmptyNote>
      )}
      {(grantStreamMutation.error || revokeStreamMutation.error) && (
        <SettingFieldError>Couldn&apos;t change channel access. Try again.</SettingFieldError>
      )}
    </SettingRow>
  )
}
