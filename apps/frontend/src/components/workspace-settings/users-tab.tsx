import { useEffect, useMemo, useRef, useState } from "react"
import { useQuery, useMutation } from "@tanstack/react-query"
import { useSearchParams } from "react-router-dom"
import { Check, Copy, KeyRound, Link as LinkIcon, Mail, MoreHorizontal, Pencil } from "lucide-react"
import { toast } from "sonner"
import {
  roleDisplayName,
  WORKSPACE_PERMISSION_SCOPES,
  WORKSPACE_ASSIGNABLE_ROLES,
  type WorkspaceInvitation,
  type WorkspaceRoleSlug,
} from "@threahq/types"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  SETTING_CONTROL_HEIGHT,
  SettingPeopleList,
  SettingActions,
  SettingControlSkeleton,
  SettingEmptyNote,
  SettingFieldError,
  SettingRow,
  SettingsDisclosure,
  SettingsSection,
  settingIds,
  SettingBadge,
  SETTING_ITEM_DIVIDERS,
} from "@/components/settings/setting-primitives"
import { SETTING_ICON_BUTTON, SETTING_MUTED_NOTE_TEXT, SETTING_NOTE_TEXT } from "@/components/settings/setting-text"
import { rankMatches } from "@/lib/match-score"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { ActorAvatar } from "@/components/actor-avatar"
import { invitationsApi, invitationKeys } from "@/api/invitations"
import { ApiError } from "@/api/client"
import { isPickableUser, useWorkspaceUsers } from "@/stores/workspace-store"
import { useFormattedDate } from "@/hooks"
import { useCoverClose } from "@/hooks/use-cover-close"
import { INVITE_LINK_COVER } from "@/lib/covers"
import { useChangeWorkspaceMemberRole, useRemoveWorkspaceMember } from "@/hooks/use-workspace-member-management"
import { useUser } from "@/auth"

import { InviteDialog } from "./invite-dialog"
import { CreateInviteLinkDialog } from "./create-invite-link-dialog"
import { EditInviteLinkDialog } from "./edit-invite-link-dialog"
import { GuestDmPolicySection } from "./guest-dm-policy-section"
import { accessDescription, useWorkspaceAccess } from "./workspace-permission"

type WorkspaceUserRow = ReturnType<typeof useWorkspaceUsers>[number]

function CopyLinkLabel({ isCopied, tokenInMemory }: { isCopied: boolean; tokenInMemory: boolean }) {
  if (isCopied) {
    return (
      <>
        <Check className="h-3.5 w-3.5 text-primary" />
        Copied
      </>
    )
  }
  if (tokenInMemory) {
    return (
      <>
        <KeyRound className="h-3.5 w-3.5 text-primary" />
        Copy link
      </>
    )
  }
  return (
    <>
      <Copy className="h-3.5 w-3.5" />
      Link hidden
    </>
  )
}

interface UsersTabProps {
  workspaceId: string
}

function buildJoinUrl(token: string): string {
  if (typeof window === "undefined") return `/join/${token}`
  return `${window.location.origin}/join/${token}`
}

function memberErrorMessage(err: unknown, fallback: string): string {
  if (!ApiError.isApiError(err)) return fallback
  switch (err.code) {
    case "OWNER_ACTION":
      return "Only workspace owners can change ownership."
    case "LAST_OWNER":
      return "Workspaces must keep at least one owner. Transfer ownership first."
    case "SELF_DEMOTE":
      return "You can't demote or remove yourself as the last owner. Transfer ownership first."
    case "FORBIDDEN":
      return "You don't have permission to manage members."
    default:
      return fallback
  }
}

function invitationErrorMessage(error: unknown, fallback: string): string {
  if (ApiError.isApiError(error)) return error.message
  if (error instanceof Error) return error.message
  return fallback
}

type InvitationGroup = "active" | "accepted" | "expired"

function isLapsed(invitation: WorkspaceInvitation, now: number): boolean {
  return (
    invitation.status === "expired" ||
    (invitation.expiresAt !== null && new Date(invitation.expiresAt).getTime() <= now)
  )
}

function isUsedUp(invitation: WorkspaceInvitation): boolean {
  return invitation.maxUses !== null && invitation.useCount >= invitation.maxUses
}

/** Where an invitation lists: still usable, taken up, or no longer usable. Revoked ones don't list. */
export function invitationGroup(invitation: WorkspaceInvitation, now: number): InvitationGroup | null {
  if (invitation.status === "revoked") return null
  if (invitation.status === "accepted") return "accepted"
  return isLapsed(invitation, now) || isUsedUp(invitation) ? "expired" : "active"
}

interface InvitationRowActions {
  now: number
  formatDate: (date: Date) => string
  copiedId: string | null
  hasToken: (invitationId: string) => boolean
  onCopy: (invitationId: string) => void
  onEdit: (invitationId: string) => void
  onRevoke: (invitation: WorkspaceInvitation) => void
  onResend: (invitationId: string) => void
  revoking: boolean
  resending: boolean
}

function InvitationList({
  label,
  invitations,
  inset,
  actions,
}: {
  label: string
  invitations: WorkspaceInvitation[]
  /** Rows sit in a card's own frame, as in a disclosure, rather than in a setting row's padding. */
  inset?: boolean
  actions: InvitationRowActions
}) {
  return (
    <ul aria-label={label} className={SETTING_ITEM_DIVIDERS}>
      {invitations.map((invitation) => (
        <li
          key={invitation.id}
          className={cn("flex min-h-11 items-center justify-between gap-2 py-2", inset && "px-4")}
        >
          {invitation.kind === "link" ? (
            <InviteLinkRow invitation={invitation} actions={actions} />
          ) : (
            <EmailInvitationRow invitation={invitation} actions={actions} />
          )}
        </li>
      ))}
    </ul>
  )
}

function InviteLinkRow({ invitation, actions }: { invitation: WorkspaceInvitation; actions: InvitationRowActions }) {
  const tokenInMemory = actions.hasToken(invitation.id)
  let state: string | null = null
  if (isLapsed(invitation, actions.now)) state = "Expired"
  else if (isUsedUp(invitation)) state = "Used up"
  const linkName = invitation.note ? `invite link “${invitation.note}”` : "invite link"
  return (
    <>
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-sm font-medium">
            <LinkIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Invite link
          </span>
          {state && <SettingBadge>{state}</SettingBadge>}
          <SettingBadge>{roleDisplayName(invitation.role)}</SettingBadge>
        </div>
        <p className={SETTING_MUTED_NOTE_TEXT}>
          {invitation.useCount} of {invitation.maxUses ?? "unlimited"} joined ·{" "}
          {invitation.expiresAt
            ? `${state === "Expired" ? "Expired" : "Expires"} ${actions.formatDate(new Date(invitation.expiresAt))}`
            : "Never expires"}
        </p>
        {invitation.note && (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <p className={cn("truncate text-muted-foreground", SETTING_NOTE_TEXT)}>{invitation.note}</p>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs text-xs">
                {invitation.note}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!state && (
          <Button
            size="sm"
            variant="outline"
            className={SETTING_CONTROL_HEIGHT}
            onClick={() => actions.onCopy(invitation.id)}
            disabled={!tokenInMemory}
          >
            <CopyLinkLabel isCopied={actions.copiedId === invitation.id} tokenInMemory={tokenInMemory} />
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className={SETTING_ICON_BUTTON} aria-label={`More for ${linkName}`}>
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => actions.onEdit(invitation.id)}>
              <Pencil aria-hidden />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              disabled={actions.revoking}
              onSelect={() => actions.onRevoke(invitation)}
            >
              Revoke
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  )
}

function emailInvitationDetail(invitation: WorkspaceInvitation, now: number, formatDate: (date: Date) => string) {
  const on = (iso: string | null, word: string) => (iso ? `${word} ${formatDate(new Date(iso))}` : word)
  if (invitation.status === "accepted") return on(invitation.acceptedAt, "Joined")
  if (isLapsed(invitation, now)) return on(invitation.expiresAt, "Expired")
  return invitation.expiresAt ? on(invitation.expiresAt, "Expires") : "Never expires"
}

function EmailInvitationRow({
  invitation,
  actions,
}: {
  invitation: WorkspaceInvitation
  actions: InvitationRowActions
}) {
  return (
    <>
      <div className="min-w-0 space-y-1">
        <span className="inline-flex min-w-0 items-center gap-1.5 truncate text-sm font-medium">
          <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {invitation.email}
        </span>
        <div className="flex items-center gap-2">
          <SettingBadge>{roleDisplayName(invitation.role)}</SettingBadge>
          <span className={SETTING_MUTED_NOTE_TEXT}>
            {emailInvitationDetail(invitation, actions.now, actions.formatDate)}
          </span>
        </div>
      </div>
      {invitation.status === "pending" && (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            className={SETTING_CONTROL_HEIGHT}
            onClick={() => actions.onResend(invitation.id)}
            disabled={actions.resending}
          >
            Resend
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className={SETTING_ICON_BUTTON}
                aria-label={`More for the invitation to ${invitation.email}`}
              >
                <MoreHorizontal aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                disabled={actions.revoking}
                onSelect={() => actions.onRevoke(invitation)}
              >
                Revoke
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </>
  )
}

export function UsersTab({ workspaceId }: UsersTabProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const closeLink = useCoverClose(INVITE_LINK_COVER)
  const [emailInviteOpen, setEmailInviteOpen] = useState(false)
  const selectedLink = searchParams.get(INVITE_LINK_COVER[0])
  const [copiedInvitationId, setCopiedInvitationId] = useState<string | null>(null)
  const [memberToRemove, setMemberToRemove] = useState<WorkspaceUserRow | null>(null)

  // Tokens are returned exactly once at create time; we keep them in-memory so
  // the admin can copy the link from the pending list. Refreshing the page
  // discards the map — there's no API to retrieve a token after creation.
  const tokensRef = useRef<Map<string, string>>(new Map())

  const { formatDate } = useFormattedDate()

  const authUser = useUser()
  const workspaceUsers = useWorkspaceUsers(workspaceId)
  const users = useMemo(
    () => workspaceUsers.filter(isPickableUser).sort((a, b) => (a.name || a.slug).localeCompare(b.name || b.slug)),
    [workspaceUsers]
  )
  const [memberFilter, setMemberFilter] = useState("")
  const shownUsers = useMemo(
    () => rankMatches(users, memberFilter, (user) => ({ labels: [user.name, user.slug] })),
    [users, memberFilter]
  )

  const memberAccess = useWorkspaceAccess(workspaceId, WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE)
  const canManageMembers = memberAccess.allowed

  const changeRoleMutation = useChangeWorkspaceMemberRole(workspaceId)
  const removeMutation = useRemoveWorkspaceMember(workspaceId)

  const invitationsQuery = useQuery({
    queryKey: invitationKeys.list(workspaceId),
    queryFn: () => invitationsApi.list(workspaceId),
    enabled: canManageMembers,
  })

  const revokeMutation = useMutation({
    mutationFn: (invitationId: string) => invitationsApi.revoke(workspaceId, invitationId),
    onSuccess: (_, invitationId) => {
      tokensRef.current.delete(invitationId)
      invitationsQuery.refetch()
    },
  })

  const resendMutation = useMutation({
    mutationFn: (invitationId: string) => invitationsApi.resend(workspaceId, invitationId),
    onSuccess: () => invitationsQuery.refetch(),
  })

  const invitations = invitationsQuery.data ?? []
  const now = Date.now()
  const grouped: Record<InvitationGroup, WorkspaceInvitation[]> = { active: [], accepted: [], expired: [] }
  for (const invitation of invitations) {
    const group = invitationGroup(invitation, now)
    if (group) grouped[group].push(invitation)
  }
  const editedInvitation =
    invitations.find(
      (invitation) => invitation.id === selectedLink && invitation.kind === "link" && invitation.status !== "revoked"
    ) ?? null

  const openLink = (value: string) => {
    const next = new URLSearchParams(searchParams)
    next.set(INVITE_LINK_COVER[0], value)
    // A stale id already in the URL (a revoked link) is the same cover: swap
    // it rather than stack a second entry Back would land on.
    setSearchParams(next, { replace: selectedLink !== null })
  }

  useEffect(() => {
    if (!copiedInvitationId) return
    const timer = setTimeout(() => setCopiedInvitationId(null), 2000)
    return () => clearTimeout(timer)
  }, [copiedInvitationId])

  const handleCopy = async (invitationId: string) => {
    const token = tokensRef.current.get(invitationId)
    if (!token) return
    try {
      await navigator.clipboard.writeText(buildJoinUrl(token))
      setCopiedInvitationId(invitationId)
    } catch {
      toast.error("Could not copy the invite link")
    }
  }

  const missingToken = grouped.active.some(
    (invitation) => invitation.kind === "link" && !tokensRef.current.has(invitation.id)
  )

  const rowActions: InvitationRowActions = {
    now,
    formatDate,
    copiedId: copiedInvitationId,
    hasToken: (invitationId) => tokensRef.current.has(invitationId),
    onCopy: handleCopy,
    onEdit: openLink,
    onRevoke: (invitation) =>
      revokeMutation.mutate(invitation.id, {
        onError: (error) =>
          toast.error(
            invitationErrorMessage(
              error,
              invitation.kind === "link" ? "Failed to revoke link" : "Failed to revoke invitation"
            )
          ),
      }),
    onResend: (invitationId) =>
      resendMutation.mutate(invitationId, {
        onError: (error) => toast.error(invitationErrorMessage(error, "Failed to resend invitation")),
      }),
    revoking: revokeMutation.isPending,
    resending: resendMutation.isPending,
  }

  return (
    <div className="space-y-8">
      <SettingsSection section="workspace-people">
        <SettingRow
          setting="members"
          labelFor={false}
          description={accessDescription("members", memberAccess, {
            base: `${users.length} ${users.length === 1 ? "person" : "people"} in this workspace.`,
            reason: "Only admins can change roles or remove people.",
          })}
        >
          <div className="space-y-2">
            <Input
              placeholder="Filter members"
              aria-label="Filter members"
              value={memberFilter}
              onChange={(event) => setMemberFilter(event.target.value)}
              className={SETTING_CONTROL_HEIGHT}
            />
            <SettingPeopleList aria-labelledby={settingIds("members").label}>
              {shownUsers.map((user) => {
                const isSelf = user.workosUserId === authUser?.id
                const name = user.name || user.slug
                // Owners aren't demotable here — ownership transfer is its own flow.
                const canEditRole =
                  canManageMembers &&
                  !isSelf &&
                  user.role !== "owner" &&
                  (WORKSPACE_ASSIGNABLE_ROLES as readonly string[]).includes(user.role)
                const canRemove = canManageMembers && !isSelf && user.role !== "owner"
                const isRoleChanging = changeRoleMutation.isPending && changeRoleMutation.variables?.userId === user.id

                return (
                  <li key={user.id} className="flex min-h-11 items-center justify-between gap-2 py-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <ActorAvatar actorId={user.id} actorType="user" workspaceId={workspaceId} size="sm" alt={name} />
                      <div className="flex min-w-0 flex-col sm:flex-row sm:items-baseline sm:gap-2">
                        <span className="truncate text-sm font-medium">
                          {name}
                          {isSelf && <span className="font-normal text-muted-foreground"> (you)</span>}
                        </span>
                        <span className={cn("truncate text-muted-foreground", SETTING_NOTE_TEXT)}>@{user.slug}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {canEditRole ? (
                        <Select
                          value={user.role}
                          disabled={isRoleChanging}
                          onValueChange={(value) =>
                            changeRoleMutation.mutate(
                              { userId: user.id, roleSlug: value as WorkspaceRoleSlug },
                              {
                                onError: (err) => toast.error(memberErrorMessage(err, "Failed to update role")),
                              }
                            )
                          }
                        >
                          <SelectTrigger className={cn("w-40", SETTING_CONTROL_HEIGHT)} aria-label={`Role for ${name}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {WORKSPACE_ASSIGNABLE_ROLES.filter((slug) => slug !== "owner").map((slug) => (
                              <SelectItem key={slug} value={slug}>
                                {roleDisplayName(slug)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <SettingBadge>{roleDisplayName(user.role)}</SettingBadge>
                      )}
                      {canRemove && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              className={SETTING_ICON_BUTTON}
                              aria-label={`Manage ${name}`}
                            >
                              <MoreHorizontal aria-hidden />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onSelect={() => setMemberToRemove(user)}
                            >
                              Remove from workspace
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  </li>
                )
              })}
            </SettingPeopleList>
            {shownUsers.length === 0 && <SettingEmptyNote>No members match.</SettingEmptyNote>}
          </div>
        </SettingRow>
      </SettingsSection>

      <SettingsSection section="workspace-invitations">
        <SettingRow
          setting="invites"
          labelFor={false}
          description={accessDescription("invites", memberAccess, { reason: "Only admins can invite people." })}
          control={
            <SettingActions>
              {!memberAccess.known ? (
                <>
                  <SettingControlSkeleton className="w-36" />
                  <SettingControlSkeleton className="w-40" />
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    className={SETTING_CONTROL_HEIGHT}
                    disabled={!canManageMembers}
                    aria-describedby={canManageMembers ? undefined : settingIds("invites").description}
                    onClick={() => setEmailInviteOpen(true)}
                  >
                    <Mail className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                    Invite by email
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className={SETTING_CONTROL_HEIGHT}
                    disabled={!canManageMembers}
                    aria-describedby={canManageMembers ? undefined : settingIds("invites").description}
                    onClick={() => openLink("create")}
                  >
                    <LinkIcon className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                    Create invite link
                  </Button>
                </>
              )}
            </SettingActions>
          }
        >
          {(grouped.active.length > 0 || invitationsQuery.isError) && (
            <div className="space-y-2">
              {grouped.active.length > 0 && (
                <InvitationList label="Open invitations" invitations={grouped.active} actions={rowActions} />
              )}
              {missingToken && (
                <p className={SETTING_MUTED_NOTE_TEXT}>
                  A link can be copied only right after it&apos;s created. Create a new one to share it again.
                </p>
              )}
              {invitationsQuery.isError && (
                <SettingFieldError>
                  {invitationErrorMessage(invitationsQuery.error, "Failed to load invitations")}
                </SettingFieldError>
              )}
            </div>
          )}
        </SettingRow>
        {grouped.accepted.length > 0 && (
          <SettingsDisclosure
            label="Accepted invitations"
            settings={[]}
            summary={`${grouped.accepted.length} accepted`}
          >
            <InvitationList label="Accepted invitations" invitations={grouped.accepted} inset actions={rowActions} />
          </SettingsDisclosure>
        )}
        {grouped.expired.length > 0 && (
          <SettingsDisclosure label="Expired invitations" settings={[]} summary={`${grouped.expired.length} expired`}>
            <InvitationList label="Expired invitations" invitations={grouped.expired} inset actions={rowActions} />
          </SettingsDisclosure>
        )}
      </SettingsSection>

      <SettingsSection section="workspace-access">
        <GuestDmPolicySection workspaceId={workspaceId} />
      </SettingsSection>

      <InviteDialog
        workspaceId={workspaceId}
        open={emailInviteOpen}
        onOpenChange={setEmailInviteOpen}
        onSuccess={() => invitationsQuery.refetch()}
      />
      <CreateInviteLinkDialog
        workspaceId={workspaceId}
        open={selectedLink === "create"}
        onOpenChange={(open) => !open && closeLink()}
        onSuccess={() => invitationsQuery.refetch()}
        onTokenCreated={(invitationId, token) => tokensRef.current.set(invitationId, token)}
      />
      <EditInviteLinkDialog
        workspaceId={workspaceId}
        invitation={editedInvitation}
        open={editedInvitation !== null}
        onOpenChange={(open) => !open && closeLink()}
        onSuccess={() => invitationsQuery.refetch()}
      />

      <AlertDialog open={memberToRemove != null} onOpenChange={(open) => !open && setMemberToRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove member</AlertDialogTitle>
            <AlertDialogDescription>
              {memberToRemove
                ? `Remove ${memberToRemove.name || memberToRemove.slug} from this workspace? They'll lose access immediately.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={removeMutation.isPending}
              onClick={(event) => {
                event.preventDefault()
                if (!memberToRemove) return
                removeMutation.mutate(
                  { userId: memberToRemove.id },
                  {
                    onError: (err) => toast.error(memberErrorMessage(err, "Failed to remove member")),
                    onSettled: () => setMemberToRemove(null),
                  }
                )
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
