import { useMemo, useRef, useState } from "react"
import { useQuery, useMutation } from "@tanstack/react-query"
import { Check, ChevronDown, Copy, KeyRound, Link as LinkIcon, Mail, MoreHorizontal } from "lucide-react"
import { toast } from "sonner"
import {
  roleDisplayName,
  WORKSPACE_PERMISSION_SCOPES,
  WORKSPACE_USER_ROLES,
  type WorkspaceRoleSlug,
} from "@threa/types"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
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
import { useWorkspaceUsers } from "@/stores/workspace-store"
import { useFormattedDate } from "@/hooks"
import { useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { useChangeWorkspaceMemberRole, useRemoveWorkspaceMember } from "@/hooks/use-workspace-member-management"
import { hasPermission } from "@/lib/permissions"
import { useUser } from "@/auth"

type WorkspaceUserRow = ReturnType<typeof useWorkspaceUsers>[number]
import { InviteDialog } from "./invite-dialog"
import { CreateInviteLinkDialog } from "./create-invite-link-dialog"

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
      Link sent
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

export function UsersTab({ workspaceId }: UsersTabProps) {
  const [emailInviteOpen, setEmailInviteOpen] = useState(false)
  const [linkInviteOpen, setLinkInviteOpen] = useState(false)
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
    () => workspaceUsers.slice().sort((a, b) => (a.name || a.slug).localeCompare(b.name || b.slug)),
    [workspaceUsers]
  )

  const bootstrap = useCachedWorkspaceBootstrap(workspaceId)
  const canManageMembers = hasPermission(bootstrap?.viewerPermissions, WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE)

  const changeRoleMutation = useChangeWorkspaceMemberRole(workspaceId)
  const removeMutation = useRemoveWorkspaceMember(workspaceId)

  const invitationsQuery = useQuery({
    queryKey: invitationKeys.list(workspaceId),
    queryFn: () => invitationsApi.list(workspaceId),
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

  const pendingInvitations = (invitationsQuery.data ?? []).filter((i) => i.status === "pending")

  const handleCopy = async (invitationId: string) => {
    const token = tokensRef.current.get(invitationId)
    if (!token) return
    try {
      await navigator.clipboard.writeText(buildJoinUrl(token))
      setCopiedInvitationId(invitationId)
      setTimeout(() => setCopiedInvitationId(null), 2000)
    } catch {
      // Clipboard API can fail in insecure contexts — ignore silently.
    }
  }

  return (
    <div className="space-y-6 p-1">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Members ({users.length})</h3>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm">
              Invite
              <ChevronDown className="ml-1 h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setEmailInviteOpen(true)}>
              <Mail className="mr-2 h-4 w-4" />
              <span>Invite by email</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setLinkInviteOpen(true)}>
              <LinkIcon className="mr-2 h-4 w-4" />
              <span>Create invite link</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="space-y-2">
        {users.map((user) => {
          const isSelf = user.workosUserId === authUser?.id
          // Owners aren't demotable here — ownership transfer is its own flow.
          const canEditRole = canManageMembers && !isSelf && user.role !== "owner"
          const canRemove = canManageMembers && !isSelf && user.role !== "owner"
          const isRoleChanging = changeRoleMutation.isPending && changeRoleMutation.variables?.userId === user.id

          return (
            <div key={user.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <ActorAvatar
                  actorId={user.id}
                  actorType="user"
                  workspaceId={workspaceId}
                  size="sm"
                  alt={user.name || user.slug}
                />
                <div className="flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-2 min-w-0">
                  <span className="text-sm font-medium truncate">{user.name || user.slug}</span>
                  <span className="text-xs text-muted-foreground truncate">@{user.slug}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
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
                    <SelectTrigger className="h-7 w-[110px] px-2 py-0 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WORKSPACE_USER_ROLES.filter((slug) => slug !== "owner").map((slug) => (
                        <SelectItem key={slug} value={slug}>
                          {roleDisplayName(slug)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge variant={user.role === "owner" ? "default" : "secondary"}>{roleDisplayName(user.role)}</Badge>
                )}
                {canRemove && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        aria-label={`Manage ${user.name || user.slug}`}
                      >
                        <MoreHorizontal className="h-4 w-4" />
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
            </div>
          )
        })}
      </div>

      {pendingInvitations.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Pending invitations ({pendingInvitations.length})</h3>
          <div className="space-y-2">
            {pendingInvitations.map((invitation) => {
              const isLink = invitation.kind === "link"
              const tokenInMemory = tokensRef.current.has(invitation.id)
              const isCopied = copiedInvitationId === invitation.id

              const unclaimedLink = isLink && !invitation.email
              return (
                <div
                  key={invitation.id}
                  className={`relative flex flex-col gap-2 rounded-md border px-3 py-2 sm:flex-row sm:items-center sm:justify-between ${
                    unclaimedLink ? "border-l-2 border-l-primary/60 bg-gradient-to-r from-primary/5 to-transparent" : ""
                  }`}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
                      {unclaimedLink ? (
                        <span className="inline-flex items-center gap-1.5 truncate text-sm font-medium">
                          <LinkIcon className="h-3.5 w-3.5 shrink-0 text-primary" />
                          Invite link
                          {tokenInMemory && (
                            <span className="text-[10px] uppercase tracking-[0.16em] text-primary/80">live</span>
                          )}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 truncate text-sm">
                          {isLink ? (
                            <LinkIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          ) : (
                            <Mail className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate">{invitation.email}</span>
                        </span>
                      )}
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge variant="outline" className="capitalize">
                          {invitation.role}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {invitation.expiresAt
                            ? `Expires ${formatDate(new Date(invitation.expiresAt))}`
                            : "Never expires"}
                        </span>
                      </div>
                    </div>
                    {invitation.note && (
                      <p
                        className="truncate pl-5 text-xs text-muted-foreground before:mr-1.5 before:text-muted-foreground/60 before:content-['—']"
                        title={invitation.note}
                      >
                        {invitation.note}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {unclaimedLink ? (
                      <Button
                        size="sm"
                        variant={tokenInMemory ? "outline" : "ghost"}
                        onClick={() => handleCopy(invitation.id)}
                        disabled={!tokenInMemory}
                        title={tokenInMemory ? "Copy link to clipboard" : "Link only available right after creation"}
                        className={tokenInMemory ? "gap-1" : "gap-1 text-muted-foreground"}
                      >
                        <CopyLinkLabel isCopied={isCopied} tokenInMemory={tokenInMemory} />
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => resendMutation.mutate(invitation.id)}
                        disabled={resendMutation.isPending}
                      >
                        Resend
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => revokeMutation.mutate(invitation.id)}
                      disabled={revokeMutation.isPending}
                    >
                      Revoke
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <InviteDialog
        workspaceId={workspaceId}
        open={emailInviteOpen}
        onOpenChange={setEmailInviteOpen}
        onSuccess={() => invitationsQuery.refetch()}
      />
      <CreateInviteLinkDialog
        workspaceId={workspaceId}
        open={linkInviteOpen}
        onOpenChange={setLinkInviteOpen}
        onSuccess={() => {
          invitationsQuery.refetch()
        }}
        onTokenCreated={(invitationId, token) => {
          tokensRef.current.set(invitationId, token)
        }}
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
