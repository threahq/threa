import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useParams } from "react-router-dom"
import { RefreshCw, MoreHorizontal, Ban, UserPlus } from "lucide-react"
import { roleDisplayName, WORKSPACE_ASSIGNABLE_ROLES, type WorkspaceRoleSlug } from "@threahq/types"
import { Section } from "@/components/layout/section"
import { CARD_CLASS, ListPlaceholder, ROW_PADDING, RowList, RowText } from "@/components/layout/rows"
import { Badge, type BadgeProps } from "@/components/ui/badge"
import { NativeSelect } from "@/components/ui/native-select"
import { InlineBanner } from "@/components/inline-banner"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
  assignWorkspaceMember,
  backofficeKeys,
  changeWorkspaceMemberRole,
  getOutboxEventsStatus,
  listWorkspaceInvitations,
  listWorkspaceMembers,
  removeWorkspaceMember,
  resyncWorkspaceMembers,
  type OutboxEventStatus,
  type ResyncWorkspaceMembersResult,
  type WorkspaceDetail,
  type WorkspaceInvitation,
  type WorkspaceMember,
} from "@/api/backoffice"
import { ApiError, readApiError } from "@/api/client"
import { cn } from "@/lib/utils"
import { formatDateTime } from "@/lib/format"

/**
 * How long the re-sync banner keeps polling outbox-event status before it
 * gives up and shows "still pending". Picked to comfortably cover the
 * outbox dispatcher's healthy drain latency (NOTIFY debounce ≤ 200ms +
 * regional round-trip) while bounding the worst case so an operator sees a
 * clear "still pending" outcome instead of a banner that polls forever.
 */
const RESYNC_POLL_TIMEOUT_MS = 15_000
const RESYNC_POLL_INTERVAL_MS = 1_500

function formatRelativeTimestamp(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const seconds = Math.floor((Date.now() - then) / 1000)
  if (seconds < 60) return "just now"
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    return `${m}m ago`
  }
  if (seconds < 86_400) {
    const h = Math.floor(seconds / 3600)
    return `${h}h ago`
  }
  const d = Math.floor(seconds / 86_400)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "2-digit" })
}

function formatRelativeFuture(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const seconds = Math.floor((then - Date.now()) / 1000)
  if (seconds <= 0) return "expired"
  if (seconds < 3600) {
    const m = Math.max(1, Math.floor(seconds / 60))
    return `in ${m}m`
  }
  if (seconds < 86_400) {
    const h = Math.floor(seconds / 3600)
    return `in ${h}h`
  }
  const d = Math.floor(seconds / 86_400)
  if (d < 30) return `in ${d}d`
  return new Date(iso).toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "2-digit" })
}

function expiryLabel(expiresAt: string | null): string {
  if (!expiresAt) return "Never expires"
  const relative = formatRelativeFuture(expiresAt)
  return relative === "expired" ? "Expired" : `Expires ${relative}`
}

function memberDisplayName(m: WorkspaceMember): string | null {
  const parts = [m.firstName, m.lastName].filter((x): x is string => !!x && x.length > 0)
  if (parts.length > 0) return parts.join(" ")
  return null
}

export function WorkspaceDetailMembersPage() {
  const { id } = useParams<{ id: string }>()
  const queryClient = useQueryClient()
  const [removeTarget, setRemoveTarget] = useState<WorkspaceMember | null>(null)

  const query = useQuery({
    queryKey: id ? backofficeKeys.workspaceMembers(id) : ["backoffice", "workspaces", "missing", "members"],
    queryFn: () => {
      if (!id) throw new Error("Missing workspace id")
      return listWorkspaceMembers(id)
    },
    enabled: !!id,
  })

  const invitationsQ = useQuery({
    queryKey: id ? backofficeKeys.workspaceInvitations(id) : ["backoffice", "workspaces", "missing", "invitations"],
    queryFn: () => {
      if (!id) throw new Error("Missing workspace id")
      return listWorkspaceInvitations(id)
    },
    enabled: !!id,
  })

  // Cache-only observer (the layout owns the actual fetch). We read the
  // workspace to differentiate "not linked to WorkOS" from "linked but empty"
  // in the empty state, since both currently come back as `members: []`.
  const workspaceQ = useQuery({
    queryKey: id ? backofficeKeys.workspace(id) : ["backoffice", "workspaces", "missing"],
    queryFn: () => (id ? (queryClient.getQueryData<WorkspaceDetail>(backofficeKeys.workspace(id)) ?? null) : null),
    enabled: !!id,
    staleTime: Infinity,
  })

  const notLinked = workspaceQ.data ? workspaceQ.data.workosOrganizationId === null : false

  // `pollStartedAt` is the wall-clock anchor for the timeout — TanStack's
  // refetchInterval can't read a ref synchronously without re-renders, so
  // state is the right shape here. Reset alongside the mutation so the next
  // re-sync starts a fresh polling window.
  const [pollStartedAt, setPollStartedAt] = useState<number | null>(null)
  const [didTimeout, setDidTimeout] = useState(false)

  const resyncMutation = useMutation({
    mutationFn: () => {
      if (!id) throw new Error("Missing workspace id")
      return resyncWorkspaceMembers(id)
    },
    onSuccess: (data) => {
      if (!id) return
      queryClient.invalidateQueries({ queryKey: backofficeKeys.workspaceMembers(id) })
      setDidTimeout(false)
      // No events means "already up to date"; skip polling entirely so the
      // banner doesn't flash "0 of 0" before settling.
      setPollStartedAt(data.outboxEventIds.length > 0 ? Date.now() : null)
    },
  })

  const eventIds = resyncMutation.data?.outboxEventIds ?? []

  const statusQ = useQuery({
    queryKey: ["backoffice", "outbox-events", "status", eventIds],
    queryFn: () => getOutboxEventsStatus(eventIds),
    enabled: eventIds.length > 0 && pollStartedAt !== null,
    refetchInterval: (query) => {
      const data = query.state.data
      if (data && data.every((s) => s.status !== "pending")) return false
      if (pollStartedAt !== null && Date.now() - pollStartedAt > RESYNC_POLL_TIMEOUT_MS) return false
      return RESYNC_POLL_INTERVAL_MS
    },
    refetchIntervalInBackground: false,
    // Background timeline: the data describes a specific moment in fan-out,
    // not a cacheable resource. Always re-fetch when we mount or focus.
    staleTime: 0,
    gcTime: 0,
  })

  // Stop polling once we've crossed the timeout with anything still pending,
  // so the banner can render the "still pending" terminal state instead of
  // looping forever. Recorded in state because refetchInterval returning
  // `false` doesn't trigger a re-render on its own.
  useEffect(() => {
    if (pollStartedAt === null) return
    const data = statusQ.data
    if (data && data.every((s) => s.status !== "pending")) {
      setPollStartedAt(null)
      return
    }
    const remaining = RESYNC_POLL_TIMEOUT_MS - (Date.now() - pollStartedAt)
    if (remaining <= 0) {
      setDidTimeout(true)
      setPollStartedAt(null)
      return
    }
    const t = window.setTimeout(() => {
      setDidTimeout(true)
      setPollStartedAt(null)
    }, remaining)
    return () => window.clearTimeout(t)
  }, [pollStartedAt, statusQ.data])

  // Clear the resync banner when navigating to a different workspace —
  // otherwise a success/error from workspace A briefly leaks onto workspace B.
  const { reset: resetResync } = resyncMutation
  useEffect(() => {
    resetResync()
    setPollStartedAt(null)
    setDidTimeout(false)
  }, [id, resetResync])

  const resyncError = readApiError(resyncMutation.error)
  const isPolling = pollStartedAt !== null

  // Patch the cached members list in place. The WorkOS event poller will
  // reconcile within ~5s, so we skip a full refetch per click.
  const patchMembers = (mutate: (members: WorkspaceMember[]) => WorkspaceMember[]) => {
    if (!id) return
    queryClient.setQueryData<WorkspaceMember[]>(backofficeKeys.workspaceMembers(id), (prev) =>
      prev ? mutate(prev) : prev
    )
  }

  const changeRoleMutation = useMutation({
    mutationFn: (vars: { workosUserId: string; roleSlug: WorkspaceRoleSlug }) => {
      if (!id) throw new Error("Missing workspace id")
      return changeWorkspaceMemberRole(id, vars.workosUserId, vars.roleSlug)
    },
    onSuccess: (_data, vars) => {
      patchMembers((members) =>
        members.map((m) => (m.workosUserId === vars.workosUserId ? { ...m, roleSlugs: [vars.roleSlug] } : m))
      )
    },
  })

  const removeMutation = useMutation({
    mutationFn: (workosUserId: string) => {
      if (!id) throw new Error("Missing workspace id")
      return removeWorkspaceMember(id, workosUserId)
    },
    onSuccess: (_data, workosUserId) => {
      patchMembers((members) => members.filter((m) => m.workosUserId !== workosUserId))
      setRemoveTarget(null)
    },
  })

  const assignMutation = useMutation({
    mutationFn: (vars: { workosUserId: string; roleSlug: WorkspaceRoleSlug }) => {
      if (!id) throw new Error("Missing workspace id")
      return assignWorkspaceMember(id, vars.workosUserId, vars.roleSlug)
    },
    onSuccess: () => {
      if (id) queryClient.invalidateQueries({ queryKey: backofficeKeys.workspaceMembers(id) })
    },
  })

  const changeRoleError = readApiError(changeRoleMutation.error)
  const removeError = readApiError(removeMutation.error)
  const assignError = readApiError(assignMutation.error)

  let busyMemberId: string | null = null
  if (changeRoleMutation.isPending) busyMemberId = changeRoleMutation.variables?.workosUserId ?? null
  else if (removeMutation.isPending) busyMemberId = removeMutation.variables ?? null

  return (
    <div className="flex flex-col gap-10">
      <Section
        label="Pending invitations"
        description="Invitations sent but not yet accepted. Link invitations stay here until someone claims them."
      >
        <InvitationsBody loading={invitationsQ.isLoading} error={invitationsQ.error} invitations={invitationsQ.data} />
      </Section>
      <Section
        label="Members"
        description="Mirror of WorkOS organization memberships. Updates within ~5s of changes in the WorkOS dashboard."
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={() => resyncMutation.mutate()}
            disabled={notLinked || resyncMutation.isPending || isPolling || !id}
          >
            <RefreshCw className={cn((resyncMutation.isPending || isPolling) && "animate-spin")} />
            {resyncButtonLabel(resyncMutation.isPending, isPolling)}
          </Button>
        }
      >
        <AssignMemberForm
          disabled={notLinked || assignMutation.isPending}
          onSubmit={(vars) => assignMutation.mutate(vars)}
        />
        {resyncMutation.isSuccess ? (
          <ResyncBanner
            result={resyncMutation.data}
            statuses={statusQ.data}
            isPolling={isPolling}
            didTimeout={didTimeout}
          />
        ) : null}
        {resyncError ? <InlineBanner tone="error">Couldn't re-sync members: {resyncError}</InlineBanner> : null}
        {changeRoleError ? <InlineBanner tone="error">Couldn't change role: {changeRoleError}</InlineBanner> : null}
        {removeError ? <InlineBanner tone="error">Couldn't remove member: {removeError}</InlineBanner> : null}
        {assignError ? <InlineBanner tone="error">Couldn't add member: {assignError}</InlineBanner> : null}
        <MembersBody
          loading={query.isLoading}
          error={query.error}
          members={query.data}
          notLinked={notLinked}
          busyMemberId={busyMemberId}
          onChangeRole={(workosUserId, roleSlug) => changeRoleMutation.mutate({ workosUserId, roleSlug })}
          onRequestRemove={(member) => setRemoveTarget(member)}
        />
      </Section>

      <ResponsiveAlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null)
        }}
      >
        <ResponsiveAlertDialogContent className="gap-5 border-t-4 border-t-destructive/70">
          <ResponsiveAlertDialogHeader>
            <div className="mb-1 flex justify-center sm:justify-start">
              <span className="inline-flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive ring-4 ring-destructive/5">
                <Ban className="size-6" strokeWidth={2.25} />
              </span>
            </div>
            <ResponsiveAlertDialogTitle className="text-xl">Remove this member?</ResponsiveAlertDialogTitle>
            <ResponsiveAlertDialogDescription>
              {removeTarget ? (
                <>
                  <span className="font-medium text-foreground">
                    {memberDisplayName(removeTarget) ?? removeTarget.email ?? removeTarget.workosUserId}
                  </span>{" "}
                  will lose access to this workspace immediately. They can be re-invited later.
                </>
              ) : null}
            </ResponsiveAlertDialogDescription>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel disabled={removeMutation.isPending}>Keep member</ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              disabled={removeMutation.isPending}
              onClick={(event) => {
                event.preventDefault()
                if (removeTarget) removeMutation.mutate(removeTarget.workosUserId)
              }}
            >
              Yes, remove
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </div>
  )
}

function AssignMemberForm({
  disabled,
  onSubmit,
}: {
  disabled: boolean
  onSubmit: (vars: { workosUserId: string; roleSlug: WorkspaceRoleSlug }) => void
}) {
  const [workosUserId, setWorkosUserId] = useState("")
  const [roleSlug, setRoleSlug] = useState<WorkspaceRoleSlug>("member")

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = workosUserId.trim()
    if (!trimmed) return
    onSubmit({ workosUserId: trimmed, roleSlug })
    setWorkosUserId("")
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={cn(CARD_CLASS, "flex flex-col gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-end")}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:min-w-64">
        <Label htmlFor="assign-workos-user-id">WorkOS user ID</Label>
        <Input
          id="assign-workos-user-id"
          value={workosUserId}
          onChange={(e) => setWorkosUserId(e.target.value)}
          placeholder="user_01H…"
          autoComplete="off"
          disabled={disabled}
          className="font-mono"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="assign-role">Role</Label>
        <NativeSelect
          id="assign-role"
          value={roleSlug}
          onChange={(e) => setRoleSlug(e.target.value as WorkspaceRoleSlug)}
          disabled={disabled}
          className="sm:w-40"
        >
          {WORKSPACE_ASSIGNABLE_ROLES.map((slug) => (
            <option key={slug} value={slug}>
              {roleDisplayName(slug)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <Button type="submit" disabled={disabled || workosUserId.trim().length === 0}>
        <UserPlus />
        Add member
      </Button>
    </form>
  )
}

function ResyncBanner({
  result,
  statuses,
  isPolling,
  didTimeout,
}: {
  result: ResyncWorkspaceMembersResult
  statuses: OutboxEventStatus[] | undefined
  isPolling: boolean
  didTimeout: boolean
}) {
  const { membershipsUpserted, membershipsRemoved, outboxEventIds } = result
  const totalChanges = membershipsUpserted + membershipsRemoved

  if (totalChanges === 0) {
    return <InlineBanner tone="success">Already up to date — no changes.</InlineBanner>
  }

  const summary = describeChanges(membershipsUpserted, membershipsRemoved)

  // No events to track — fan-out path was empty. We shouldn't hit this when
  // `totalChanges > 0`, but the early return keeps the rest of the function
  // working with a non-empty event set.
  if (outboxEventIds.length === 0) {
    return <InlineBanner tone="success">Re-sync complete — {summary}.</InlineBanner>
  }

  const total = outboxEventIds.length
  // `statuses` lags the mutation by one network round-trip; treat the
  // pre-first-poll window as "all pending" rather than rendering "0 of N
  // processed" momentarily as a deceptive success state.
  const known = statuses ?? outboxEventIds.map((id) => ({ id, status: "pending" as const }))
  const processed = known.filter((s) => s.status === "processed").length
  const deadLettered = known.filter((s) => s.status === "dead_lettered").length
  const pending = total - processed - deadLettered

  if (deadLettered > 0) {
    const eventsWord = `event${total === 1 ? "" : "s"}`
    return (
      <InlineBanner tone="error">
        Re-sync committed ({summary}) but fan-out failed for {deadLettered} of {total} {eventsWord}
        {isPolling ? " so far — still checking the rest." : " — check control-plane logs for the dead-letter queue."}
      </InlineBanner>
    )
  }

  if (isPolling) {
    return (
      <InlineBanner tone="success">
        Re-sync committed ({summary}) — {processed} of {total} propagated to regional permissions.
      </InlineBanner>
    )
  }

  if (didTimeout && pending > 0) {
    return (
      <InlineBanner tone="error">
        Re-sync committed ({summary}) but {pending} of {total} event{total === 1 ? "" : "s"}{" "}
        {pending === 1 ? "is" : "are"} still pending fan-out. Reload in a few seconds to check progress.
      </InlineBanner>
    )
  }

  return (
    <InlineBanner tone="success">
      Re-sync complete — {summary}, all {total} event{total === 1 ? "" : "s"} propagated.
    </InlineBanner>
  )
}

function resyncButtonLabel(isMutating: boolean, isPolling: boolean): string {
  if (isMutating) return "Re-syncing…"
  if (isPolling) return "Propagating…"
  return "Re-sync members"
}

function describeChanges(upserted: number, removed: number): string {
  const parts: string[] = []
  if (upserted > 0) parts.push(`${upserted} upserted`)
  if (removed > 0) parts.push(`${removed} removed`)
  return parts.join(", ")
}

function MembersBody({
  loading,
  error,
  members,
  notLinked,
  busyMemberId,
  onChangeRole,
  onRequestRemove,
}: {
  loading: boolean
  error: unknown
  members: WorkspaceMember[] | undefined
  notLinked: boolean
  busyMemberId: string | null
  onChangeRole: (workosUserId: string, roleSlug: WorkspaceRoleSlug) => void
  onRequestRemove: (member: WorkspaceMember) => void
}) {
  if (loading) {
    return <ListPlaceholder>Loading members…</ListPlaceholder>
  }

  if (error) {
    const notFound = ApiError.isApiError(error) && error.status === 404
    return <ListPlaceholder>{notFound ? "That workspace doesn't exist." : "Couldn't load members."}</ListPlaceholder>
  }

  if (!members || members.length === 0) {
    return (
      <ListPlaceholder>
        {notLinked
          ? "Workspace isn't linked to a WorkOS organization — no mirror data to show."
          : "No members yet — backfill may still be running."}
      </ListPlaceholder>
    )
  }

  return (
    <RowList>
      {members.map((m) => (
        <MemberRow
          key={`${m.workosUserId}`}
          member={m}
          busy={busyMemberId === m.workosUserId}
          onChangeRole={(roleSlug) => onChangeRole(m.workosUserId, roleSlug)}
          onRequestRemove={() => onRequestRemove(m)}
        />
      ))}
    </RowList>
  )
}

function MemberRow({
  member,
  busy,
  onChangeRole,
  onRequestRemove,
}: {
  member: WorkspaceMember
  busy: boolean
  onChangeRole: (roleSlug: WorkspaceRoleSlug) => void
  onRequestRemove: () => void
}) {
  const name = memberDisplayName(member)
  const fallback = member.email ?? member.workosUserId
  const memberRoleSet = new Set(member.roleSlugs)
  return (
    <li className={cn("flex min-h-14 items-center gap-4", ROW_PADDING)}>
      <RowText
        title={name ?? fallback}
        badges={<RoleChips roles={member.roleSlugs} />}
        meta={name && member.email ? member.email : null}
      />
      <div className="flex shrink-0 items-center gap-3">
        <StatusBadge status={member.status} />
        <span
          className="hidden w-24 text-right text-sm tabular-nums text-muted-foreground sm:inline-block"
          title={formatDateTime(member.lastEventAt)}
        >
          {formatRelativeTimestamp(member.lastEventAt)}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="size-9 [@media(pointer:coarse)]:size-11"
              disabled={busy}
              aria-label={`Manage ${name ?? fallback}`}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Change role</div>
            {WORKSPACE_ASSIGNABLE_ROLES.map((slug) => {
              const memberHasRole = memberRoleSet.has(slug)
              return (
                <DropdownMenuItem key={slug} disabled={busy || memberHasRole} onSelect={() => onChangeRole(slug)}>
                  {roleDisplayName(slug)}
                  {memberHasRole ? <span className="ml-2 text-xs text-muted-foreground">current</span> : null}
                </DropdownMenuItem>
              )
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              disabled={busy}
              onSelect={onRequestRemove}
            >
              Remove from workspace
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  )
}

function RoleChips({ roles }: { roles: string[] }) {
  return (
    <>
      {roles.map((role) => (
        <Badge key={role} className="capitalize">
          {role}
        </Badge>
      ))}
    </>
  )
}

function InvitationsBody({
  loading,
  error,
  invitations,
}: {
  loading: boolean
  error: unknown
  invitations: WorkspaceInvitation[] | undefined
}) {
  if (loading) {
    return <ListPlaceholder>Loading invitations…</ListPlaceholder>
  }

  if (error) {
    const notFound = ApiError.isApiError(error) && error.status === 404
    return (
      <ListPlaceholder>{notFound ? "That workspace doesn't exist." : "Couldn't load invitations."}</ListPlaceholder>
    )
  }

  if (!invitations || invitations.length === 0) {
    return <ListPlaceholder>No pending invitations.</ListPlaceholder>
  }

  return (
    <RowList>
      {invitations.map((inv) => (
        <InvitationRow key={inv.id} invitation={inv} />
      ))}
    </RowList>
  )
}

function InvitationRow({ invitation }: { invitation: WorkspaceInvitation }) {
  const primary = invitation.email ?? "Unclaimed link"
  const inviterName = invitation.inviter ? (invitation.inviter.name ?? invitation.inviter.email ?? "Unknown") : null
  return (
    <li className={cn("flex min-h-14 items-center gap-4", ROW_PADDING)}>
      <RowText
        title={primary}
        badges={
          <>
            <Badge tone={invitation.kind === "link" ? "primary" : "neutral"} className="capitalize">
              {invitation.kind}
            </Badge>
            <RoleChips roles={[invitation.roleSlug]} />
          </>
        }
        meta={inviterName ? `Invited by ${inviterName}` : null}
      />
      <div className="flex shrink-0 items-center gap-3">
        <span
          className="hidden text-sm tabular-nums text-muted-foreground sm:inline"
          title={invitation.expiresAt ? formatDateTime(invitation.expiresAt) : "Never expires"}
        >
          {expiryLabel(invitation.expiresAt)}
        </span>
      </div>
    </li>
  )
}

const STATUS_TONE: Record<string, BadgeProps["tone"]> = {
  active: "success",
  pending: "warning",
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={STATUS_TONE[status] ?? "neutral"} className="capitalize">
      {status}
    </Badge>
  )
}
