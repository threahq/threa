import { useState, useMemo, useCallback } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { SearchableSelect } from "@/components/ui/searchable-select"
import { ActorAvatar } from "@/components/actor-avatar"
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
import { X, UserPlus, BotIcon } from "lucide-react"
import { useAddStreamMember, useRemoveStreamMember, streamKeys } from "@/hooks"
import { useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { useInviteActor } from "@/hooks/use-invite-actor"
import { useStreamService } from "@/contexts"
import { botsApi } from "@/api/bots"
import { useWorkspaceUsers, useWorkspaceBots } from "@/stores/workspace-store"
import { hasPermission } from "@/lib/permissions"
import { StreamTypes, WORKSPACE_PERMISSION_SCOPES, type Stream, type StreamMember } from "@threa/types"
import { toast } from "sonner"

interface MembersTabProps {
  workspaceId: string
  streamId: string
  currentUserId: string
}

export function MembersTab({ workspaceId, streamId, currentUserId }: MembersTabProps) {
  const streamService = useStreamService()
  const [search, setSearch] = useState("")
  const addMutation = useAddStreamMember(workspaceId, streamId)
  const removeMutation = useRemoveStreamMember(workspaceId, streamId)

  // Fetch stream bootstrap if not cached (e.g. settings opened from sidebar without viewing stream).
  // staleTime: Infinity so this observer never refetches existing data — useStreamBootstrap's
  // observer (staleTime: 0) will still re-run its queryFn (which includes socket room joining)
  // when the user navigates to the stream.
  const { data: bootstrap } = useQuery({
    queryKey: streamKeys.bootstrap(workspaceId, streamId),
    queryFn: () => streamService.bootstrap(workspaceId, streamId),
    staleTime: Infinity,
  })
  const workspaceBootstrap = useCachedWorkspaceBootstrap(workspaceId)
  const workspaceUsers = useWorkspaceUsers(workspaceId)

  const streamType = bootstrap?.stream?.type
  const streamMembers = bootstrap?.members ?? []
  const canManageMembers = hasPermission(
    workspaceBootstrap?.viewerPermissions,
    WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE
  )
  const canAddUserMembers = canManageMembers && streamType === StreamTypes.CHANNEL

  // Bots can be managed on all stream types that have a members tab.
  // Threads inherit bot access from their root, so the UI is read-only.
  const canManageBots = canManageMembers && streamType !== undefined
  const botsReadOnly = streamType === StreamTypes.THREAD

  const streamMemberIds = useMemo(() => new Set(streamMembers.map((m) => m.memberId)), [streamMembers])

  const enrichedMembers = useMemo(() => {
    const enriched = streamMembers
      .map((sm) => {
        const workspaceUser = workspaceUsers.find((u) => u.id === sm.memberId)
        return workspaceUser
          ? { ...sm, name: workspaceUser.name, slug: workspaceUser.slug, role: workspaceUser.role }
          : null
      })
      .filter(Boolean) as (StreamMember & { name: string; slug: string; role: string })[]
    return enriched.sort((a, b) => (a.name || a.slug).localeCompare(b.name || b.slug))
  }, [streamMembers, workspaceUsers])

  const filteredMembers = useMemo(() => {
    if (!search) return enrichedMembers
    const q = search.toLowerCase()
    return enrichedMembers.filter((m) => m.name.toLowerCase().includes(q) || m.slug.toLowerCase().includes(q))
  }, [enrichedMembers, search])

  const availableToAdd = useMemo(() => {
    return workspaceUsers
      .filter((m) => !streamMemberIds.has(m.id))
      .sort((a, b) => (a.name || a.slug).localeCompare(b.name || b.slug))
  }, [workspaceUsers, streamMemberIds])

  const handleAdd = useCallback(
    (user: (typeof workspaceUsers)[number]) => {
      if (!canManageMembers) return
      addMutation.mutate(user.id, {
        onError: () => toast.error("Failed to add member"),
      })
    },
    [addMutation, canManageMembers]
  )

  const [removeMemberId, setRemoveMemberId] = useState<string | null>(null)
  const removeMemberName = removeMemberId
    ? (enrichedMembers.find((m) => m.memberId === removeMemberId)?.name ?? removeMemberId)
    : null

  const handleRemove = () => {
    if (!removeMemberId) return
    removeMutation.mutate(removeMemberId, {
      onError: () => toast.error("Failed to remove member"),
    })
    setRemoveMemberId(null)
  }

  return (
    <div className="space-y-6 p-1">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">Members ({enrichedMembers.length})</Label>
        </div>

        <Input
          placeholder="Filter members..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8"
        />

        <div className="space-y-1 max-h-64 overflow-y-auto">
          {filteredMembers.map((member) => {
            return (
              <div key={member.memberId} className="flex items-center justify-between rounded-md border px-3 py-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <ActorAvatar
                    actorId={member.memberId}
                    actorType="user"
                    workspaceId={workspaceId}
                    size="sm"
                    alt={member.name || member.slug}
                  />
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-sm font-medium truncate">{member.name || member.slug}</span>
                    <span className="text-xs text-muted-foreground">@{member.slug}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant={member.role === "owner" ? "default" : "secondary"} className="text-xs">
                    {member.role}
                  </Badge>
                  {canManageMembers && member.memberId !== currentUserId && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => setRemoveMemberId(member.memberId)}
                      disabled={removeMutation.isPending}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
          {filteredMembers.length === 0 && <p className="text-sm text-muted-foreground py-2">No members found</p>}
        </div>
      </div>

      {canAddUserMembers && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">Add member</Label>
          <SearchableSelect
            items={availableToAdd}
            value={null}
            onChange={handleAdd}
            getKey={(u) => u.id}
            getKeywords={(u) => [u.name, u.slug, `@${u.slug}`]}
            placeholder={availableToAdd.length === 0 ? "All workspace users are members" : "Add member..."}
            searchPlaceholder="Search workspace users..."
            emptyMessage="No matching users"
            triggerIcon={UserPlus}
            disabled={availableToAdd.length === 0}
            showAvailableCount
            availableLabel={(n) => `${n} ${n === 1 ? "user" : "users"} available`}
            renderItem={(user) => (
              <>
                <ActorAvatar
                  actorId={user.id}
                  actorType="user"
                  workspaceId={workspaceId}
                  size="xs"
                  alt={user.name || user.slug}
                />
                <span className="text-sm font-medium truncate">{user.name || user.slug}</span>
                <span className="ml-auto text-xs text-muted-foreground shrink-0">@{user.slug}</span>
              </>
            )}
          />
        </div>
      )}

      {canManageBots && (
        <>
          <Separator />
          <StreamBotsSection
            workspaceId={workspaceId}
            streamId={streamId}
            readOnly={botsReadOnly}
            stream={bootstrap?.stream}
          />
        </>
      )}

      <ResponsiveAlertDialog open={removeMemberId !== null} onOpenChange={(open) => !open && setRemoveMemberId(null)}>
        <ResponsiveAlertDialogContent>
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>Remove member?</ResponsiveAlertDialogTitle>
            <ResponsiveAlertDialogDescription>
              Are you sure you want to remove {removeMemberName} from this stream?
            </ResponsiveAlertDialogDescription>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>Cancel</ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction onClick={handleRemove}>Remove</ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </div>
  )
}

export function StreamBotsSection({
  workspaceId,
  streamId,
  readOnly,
  stream,
}: {
  workspaceId: string
  streamId: string
  readOnly?: boolean
  stream?: Stream
}) {
  const queryClient = useQueryClient()
  const allBots = useWorkspaceBots(workspaceId)
  const { invite, isInviting, isUnlocked } = useInviteActor(workspaceId, streamId)

  // On an E2E scratchpad the stream key must be wrapped to the bot before it can
  // participate; that grant is the owner's deliberate act, so it goes behind a
  // confirm instead of the silent plaintext grant. Wrapping needs the owner's
  // unlocked session, so the affordance is gated on it (as renaming is) — adding
  // while locked would list the bot as a member it can't yet decrypt for.
  const isE2e = stream?.e2eEnabled === true
  const e2eLocked = isE2e && !isUnlocked
  const [pendingGrantBot, setPendingGrantBot] = useState<(typeof allBots)[number] | null>(null)

  const streamBotsQueryKey = ["stream-bots", workspaceId, streamId]
  const { data: grantedBotIds = [] } = useQuery({
    queryKey: streamBotsQueryKey,
    queryFn: () => botsApi.listStreamBots(workspaceId, streamId),
  })

  const grantedBotIdSet = useMemo(() => new Set(grantedBotIds), [grantedBotIds])

  const botsWithAccess = useMemo(
    () => allBots.filter((b) => grantedBotIdSet.has(b.id)).sort((a, b) => a.name.localeCompare(b.name)),
    [allBots, grantedBotIdSet]
  )

  const availableToGrant = useMemo(
    () =>
      allBots.filter((b) => !b.archivedAt && !grantedBotIdSet.has(b.id)).sort((a, b) => a.name.localeCompare(b.name)),
    [allBots, grantedBotIdSet]
  )

  const grantMutation = useMutation({
    mutationFn: (botId: string) => botsApi.grantStreamAccess(workspaceId, botId, streamId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: streamBotsQueryKey }),
    onError: () => toast.error("Failed to add bot"),
  })

  const revokeMutation = useMutation({
    mutationFn: (botId: string) => botsApi.revokeStreamAccess(workspaceId, botId, streamId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: streamBotsQueryKey }),
  })

  const handleSelectBot = useCallback(
    (bot: (typeof allBots)[number]) => {
      if (isE2e) {
        setPendingGrantBot(bot)
      } else {
        grantMutation.mutate(bot.id)
      }
    },
    [isE2e, grantMutation]
  )

  const confirmE2eGrant = useCallback(async () => {
    if (!pendingGrantBot) return
    const bot = pendingGrantBot
    setPendingGrantBot(null)
    try {
      const alreadyActor = stream?.e2eActors?.some((a) => a.kind === "bot" && a.actorId === bot.id) ?? false
      // Roll + wrap the stream key to the bot so it can decrypt. Skipped when the
      // actor row already exists (re-granting after a channel revoke) — a second
      // invite would 409. A locked session records the actor unwrapped and warns
      // (handled inside useInviteActor); the re-key happens when next unlocked.
      if (!alreadyActor) await invite("bot", bot.id)
      // Standing channel grant so the bot lists here and can write back its turn.
      await grantMutation.mutateAsync(bot.id)
    } catch {
      // invite() and the grant mutation each surface their own error toast.
    }
  }, [pendingGrantBot, stream?.e2eActors, invite, grantMutation])

  return (
    <div className="space-y-3">
      <Label className="text-sm font-medium">Bots ({botsWithAccess.length})</Label>

      {botsWithAccess.length > 0 && (
        <div className="space-y-1">
          {botsWithAccess.map((bot) => (
            <div
              key={bot.id}
              className="flex items-center justify-between rounded-md border px-3 py-2 group reveal-host"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <ActorAvatar actorId={bot.id} actorType="bot" workspaceId={workspaceId} size="sm" alt={bot.name} />
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-sm font-medium truncate">{bot.name}</span>
                  {bot.slug && <span className="text-xs text-muted-foreground">@{bot.slug}</span>}
                </div>
              </div>
              {!readOnly && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="reveal-actions h-6 w-6 shrink-0"
                  onClick={() => revokeMutation.mutate(bot.id)}
                  disabled={revokeMutation.isPending}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {botsWithAccess.length === 0 && allBots.length > 0 && (
        <p className="text-xs text-muted-foreground">No bots have been added to this stream.</p>
      )}

      {allBots.length === 0 && (
        <p className="text-xs text-muted-foreground">No bots in this workspace. Create one in workspace settings.</p>
      )}

      {!readOnly && allBots.length > 0 && (
        <SearchableSelect
          items={availableToGrant}
          value={null}
          onChange={handleSelectBot}
          getKey={(b) => b.id}
          getKeywords={(b) => [b.name, b.slug ?? "", b.slug ? `@${b.slug}` : ""].filter(Boolean)}
          placeholder={availableToGrant.length === 0 ? "All bots have access" : "Add bot..."}
          searchPlaceholder="Search bots..."
          emptyMessage="No matching bots"
          triggerIcon={BotIcon}
          disabled={availableToGrant.length === 0 || grantMutation.isPending || isInviting || e2eLocked}
          showAvailableCount
          availableLabel={(n) => `${n} ${n === 1 ? "bot" : "bots"} available`}
          renderItem={(bot) => (
            <>
              <ActorAvatar actorId={bot.id} actorType="bot" workspaceId={workspaceId} size="xs" alt={bot.name} />
              <span className="text-sm font-medium truncate">{bot.name}</span>
              {bot.slug && <span className="ml-auto text-xs text-muted-foreground shrink-0">@{bot.slug}</span>}
            </>
          )}
        />
      )}

      {!readOnly && allBots.length > 0 && e2eLocked && (
        <p className="text-xs text-muted-foreground">Unlock this scratchpad&rsquo;s encryption to add a bot.</p>
      )}

      <ResponsiveAlertDialog open={pendingGrantBot !== null} onOpenChange={(open) => !open && setPendingGrantBot(null)}>
        <ResponsiveAlertDialogContent>
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              Add {pendingGrantBot?.name} to this encrypted scratchpad?
            </ResponsiveAlertDialogTitle>
            <ResponsiveAlertDialogDescription>
              This bot will be able to read every message in this end-to-end encrypted scratchpad. Only add bots you
              trust with this conversation.
            </ResponsiveAlertDialogDescription>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>Cancel</ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction onClick={confirmE2eGrant}>Add bot</ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </div>
  )
}
