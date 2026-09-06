import { useMemo } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { botsApi } from "@/api/bots"
import { StreamTypes } from "@threahq/types"
import { useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { SearchableSelect } from "@/components/ui/searchable-select"
import { Hash, X } from "lucide-react"

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

  return (
    <section className="space-y-3">
      <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Channel Access</h4>

      <p className="text-xs text-muted-foreground">
        Bots can access all public channels. Grant access to specific private channels below.
      </p>

      {grantedStreams.length > 0 && (
        <div className="rounded-md border divide-y">
          {grantedStreams.map((grant) => (
            <div key={grant.streamId} className="flex items-center justify-between px-3 py-2 group reveal-host">
              <div className="flex items-center gap-2 min-w-0">
                <Hash className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-sm truncate">{grant.slug ?? grant.displayName ?? grant.streamId}</span>
              </div>
              {!isArchived && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="reveal-actions h-6 w-6 shrink-0"
                  onClick={() => revokeStreamMutation.mutate(grant.streamId)}
                  disabled={revokeStreamMutation.isPending}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {grantedStreams.length === 0 && (
        <p className="text-xs text-muted-foreground italic">No private channel access granted.</p>
      )}

      {!isArchived && (
        <SearchableSelect
          items={availableChannels}
          value={null}
          onChange={(stream) => grantStreamMutation.mutate(stream.id)}
          getKey={(s) => s.id}
          getKeywords={(s) =>
            [s.slug ?? "", s.slug ? `#${s.slug}` : "", s.displayName ?? ""].filter(Boolean) as string[]
          }
          placeholder={availableChannels.length === 0 ? "All channels granted" : "Grant channel access..."}
          searchPlaceholder="Search channels..."
          emptyMessage="No matching channels"
          triggerIcon={Hash}
          disabled={availableChannels.length === 0 || grantStreamMutation.isPending}
          showAvailableCount
          availableLabel={(n) => `${n} ${n === 1 ? "channel" : "channels"} available`}
          renderItem={(stream) => (
            <>
              <Hash className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-sm truncate">{stream.slug ?? stream.displayName}</span>
              <Badge variant="outline" className="ml-auto text-[10px] shrink-0">
                {stream.visibility}
              </Badge>
            </>
          )}
        />
      )}
    </section>
  )
}
