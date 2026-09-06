import { useParams, Link } from "react-router-dom"
import { MessageCircle, Phone, Github, Globe } from "lucide-react"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogBody,
} from "@/components/ui/responsive-dialog"
import { createDmDraftId } from "@/hooks"
import { useFeatureFlag } from "@/hooks/use-feature-flags"
import { useCallLaunch } from "@/components/call"
import { useWorkspaceUsers, useWorkspaceDmPeers } from "@/stores/workspace-store"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { useAuth } from "@/auth"
import { getAvatarUrl, resolveActiveStatus, type User } from "@threahq/types"
import { getInitials } from "@/lib/initials"
import { formatStatusClearLabel } from "@/lib/status"

/**
 * The profile Call button. A call needs a real DM stream (v1 has no message-less
 * DM materialization — `createDm` posts on first send), and can't start while the
 * viewer is already in a call. When disabled, the reason is exposed through a
 * focusable Tooltip wrapper rather than a native `title` on the disabled button —
 * a disabled button isn't focusable and screen readers don't announce an
 * ancestor's `title`, so `title` alone reaches neither keyboard, SR, nor touch.
 */
function ProfileCallButton({
  workspaceId,
  dmStreamId,
  callActive,
  onLaunch,
}: {
  workspaceId: string | undefined
  dmStreamId: string | undefined
  callActive: boolean
  onLaunch: (streamId: string) => void
}) {
  let disabledReason: string | null = null
  if (!dmStreamId) disabledReason = "Send a message first to start a call"
  else if (callActive) disabledReason = "You're already in a call"

  const button = (
    <Button
      variant="outline"
      disabled={disabledReason !== null}
      onClick={() => {
        if (disabledReason !== null || !workspaceId || !dmStreamId) return
        onLaunch(dmStreamId)
      }}
    >
      <Phone className="h-4 w-4 mr-2" />
      Call
    </Button>
  )

  if (disabledReason === null) return button

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex rounded-md">
          {button}
        </span>
      </TooltipTrigger>
      <TooltipContent>{disabledReason}</TooltipContent>
    </Tooltip>
  )
}

function getRoleBadge(role: User["role"]) {
  switch (role) {
    case "owner":
      return <Badge variant="secondary">Owner</Badge>
    case "admin":
      return <Badge variant="secondary">Admin</Badge>
    default:
      return null
  }
}

interface UserProfileModalProps {
  userId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function UserProfileModal({ userId, open, onOpenChange }: UserProfileModalProps) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { user: authUser } = useAuth()
  const idbUsers = useWorkspaceUsers(workspaceId ?? "")
  const idbDmPeers = useWorkspaceDmPeers(workspaceId ?? "")
  const { toEmoji } = useWorkspaceEmoji(workspaceId ?? "")

  const user = idbUsers.find((u) => u.id === userId)
  const isOwnProfile = authUser && user?.workosUserId === authUser.id
  const avatarUrl = user ? getAvatarUrl(workspaceId!, user.avatarUrl, 256) : undefined
  const activeStatus = user
    ? resolveActiveStatus({
        statusEmoji: user.statusEmoji ?? null,
        statusText: user.statusText ?? null,
        statusExpiresAt: user.statusExpiresAt ?? null,
      })
    : null
  const statusGlyph = activeStatus?.emoji ? toEmoji(activeStatus.emoji) : null

  const existingDmStreamId = idbDmPeers.find((p) => p.userId === userId)?.streamId
  const messageStreamId = existingDmStreamId ?? createDmDraftId(userId)
  const messageHref = workspaceId ? `/w/${workspaceId}/s/${messageStreamId}` : undefined

  const callsEnabled = useFeatureFlag(workspaceId ?? "", "calls") === "on"
  const { launch: launchCall, callActive } = useCallLaunch()

  if (!user) return null

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent desktopClassName="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="sr-only">Profile</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="sr-only">Profile for {user.name}</ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-4 pb-6">
          <div className="flex flex-col items-center gap-3 pt-2">
            <Avatar className="h-24 w-24 rounded-2xl">
              {avatarUrl && <AvatarImage src={avatarUrl} alt={user.name} />}
              <AvatarFallback className="text-2xl bg-muted text-foreground rounded-2xl">
                {getInitials(user.name)}
              </AvatarFallback>
            </Avatar>
            <div className="text-center">
              <h2 className="text-xl font-semibold">{user.name}</h2>
              {user.pronouns && <p className="text-sm text-muted-foreground">{user.pronouns}</p>}
              {activeStatus && (statusGlyph || activeStatus.text) && (
                <>
                  <p className="mt-1 flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
                    {statusGlyph && <span className="leading-none">{statusGlyph}</span>}
                    {activeStatus.text && <span>{activeStatus.text}</span>}
                  </p>
                  {formatStatusClearLabel(activeStatus.expiresAt) && (
                    <p className="text-xs text-muted-foreground/70">{formatStatusClearLabel(activeStatus.expiresAt)}</p>
                  )}
                </>
              )}
              <div className="mt-1">{getRoleBadge(user.role)}</div>
            </div>
          </div>

          {user.description && <p className="text-sm text-center text-muted-foreground">{user.description}</p>}

          {(user.phone || user.githubUsername || user.timezone) && (
            <>
              <Separator />
              <div className="space-y-2.5">
                {user.phone && (
                  <div className="flex items-center gap-2.5 text-sm">
                    <Phone className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span>{user.phone}</span>
                  </div>
                )}
                {user.githubUsername && (
                  <div className="flex items-center gap-2.5 text-sm">
                    <Github className="h-4 w-4 text-muted-foreground shrink-0" />
                    <a
                      href={`https://github.com/${user.githubUsername}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                    >
                      {user.githubUsername}
                    </a>
                  </div>
                )}
                {user.timezone && (
                  <div className="flex items-center gap-2.5 text-sm">
                    <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span>{user.timezone}</span>
                  </div>
                )}
              </div>
            </>
          )}

          {!isOwnProfile && messageHref && (
            <>
              <Separator />
              <div className="flex gap-2">
                <Link
                  to={messageHref}
                  onClick={() => onOpenChange(false)}
                  className={buttonVariants({ className: "flex-1" })}
                >
                  <MessageCircle className="h-4 w-4 mr-2" />
                  Message
                </Link>
                {callsEnabled && (
                  <ProfileCallButton
                    workspaceId={workspaceId}
                    dmStreamId={existingDmStreamId}
                    callActive={callActive}
                    onLaunch={(streamId) => {
                      onOpenChange(false)
                      launchCall({ workspaceId: workspaceId!, streamId, mode: "video" })
                    }}
                  />
                )}
              </div>
            </>
          )}
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
