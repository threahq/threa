import { useState } from "react"
import { Link, Navigate, useNavigate } from "react-router-dom"
import { useAuth } from "@/auth"
import { useWorkspaces, useCreateWorkspace, useAcceptInvitation, useRegions } from "@/hooks"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ThreaLogo } from "@/components/threa-logo"
import { ApiError } from "@/api/client"
import { formatRegion } from "@/lib/regions"
import { INVITATION_ERROR_CODES, isInvitationErrorCode, type InvitationErrorCode } from "@/api/invitations"

const ACCEPT_INVITATION_ERRORS: Record<InvitationErrorCode, string> = {
  [INVITATION_ERROR_CODES.REVOKED]: "This invitation was revoked.",
  [INVITATION_ERROR_CODES.EXPIRED]: "This invitation has expired.",
  [INVITATION_ERROR_CODES.EXHAUSTED]: "This invite link has reached its join limit.",
  [INVITATION_ERROR_CODES.EMAIL_MISMATCH]: "Sign in with the email address that received this invitation.",
  [INVITATION_ERROR_CODES.NOT_FOUND]: "This invitation is no longer available.",
  [INVITATION_ERROR_CODES.ALREADY_CLAIMED]: "This invite link has already been used.",
}

function getAcceptInvitationErrorMessage(error: unknown): string {
  if (ApiError.isApiError(error)) {
    return isInvitationErrorCode(error.code) ? ACCEPT_INVITATION_ERRORS[error.code] : error.message
  }
  if (error instanceof Error) return error.message
  return "Failed to accept invitation."
}

function getCreateWorkspaceErrorMessage(error: unknown): string | null {
  if (!error) return null
  if (ApiError.isApiError(error) && error.status === 403 && error.code === "WORKSPACE_CREATION_INVITE_REQUIRED") {
    return "Workspace creation requires a dedicated workspace invite."
  }
  if (error instanceof Error) {
    return error.message
  }
  return "Failed to create workspace"
}

export function WorkspaceSelectPage() {
  const { user, loading: authLoading } = useAuth()
  const { workspaces, cachedWorkspaces, pendingInvitations, isLoading: workspacesLoading, error } = useWorkspaces()
  // Prefer the freshly fetched list; fall back to the IDB-cached one so a
  // returning user sees their workspaces instantly while the list query
  // revalidates in the background instead of staring at a full-screen spinner
  // on a slow network. `useLiveQuery` yields `undefined` until the IDB read
  // resolves, then an array (possibly empty) — that distinction is
  // load-bearing in the loading states below so neither boot path flashes.
  const cacheResolved = cachedWorkspaces !== undefined
  const displayWorkspaces = workspaces ?? cachedWorkspaces
  const { data: regions } = useRegions()
  const createWorkspace = useCreateWorkspace()
  const acceptInvitation = useAcceptInvitation()
  const navigate = useNavigate()
  const [newWorkspaceName, setNewWorkspaceName] = useState("")
  const [selectedRegion, setSelectedRegion] = useState<string | undefined>()
  const [acceptingId, setAcceptingId] = useState<string | null>(null)
  const [acceptError, setAcceptError] = useState<string | null>(null)
  const createWorkspaceErrorMessage = getCreateWorkspaceErrorMessage(createWorkspace.error)
  const showRegionPicker = regions && regions.length > 1

  const handleCreateWorkspace = async (e: React.FormEvent) => {
    e.preventDefault()
    const name = newWorkspaceName.trim()
    if (!name) return

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    const workspace = await createWorkspace.mutateAsync({ name, slug, region: selectedRegion })
    navigate(`/w/${workspace.id}`)
  }

  const handleAcceptInvitation = (invitationId: string) => {
    setAcceptingId(invitationId)
    setAcceptError(null)
    acceptInvitation.mutate(invitationId, {
      onSuccess: ({ workspaceId }) => {
        navigate(`/w/${workspaceId}/setup`, { replace: true })
      },
      onError: (error) => {
        setAcceptingId(null)
        setAcceptError(getAcceptInvitationErrorMessage(error))
      },
    })
  }

  // Redirect to login if not authenticated
  if (!authLoading && !user) {
    return <Navigate to="/login" replace />
  }

  if (!displayWorkspaces?.length && !error) {
    // First tick of a warm boot: the IDB read hasn't resolved yet and there's
    // no fresh data, but a cached list is about to appear. Render nothing for
    // that sub-frame (~16ms, imperceptible) rather than a spinner we'd
    // immediately replace — flashing the spinner on and off *is* the flicker.
    if (workspaces === undefined && !cacheResolved && workspacesLoading && !authLoading) {
      return null
    }
    // Genuine cold visit: auth still resolving, or the IDB cache resolved
    // empty and we're still waiting on the network. Nothing to show → spinner.
    if (authLoading || workspacesLoading) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-background">
          <div className="flex flex-col items-center gap-4">
            <ThreaLogo size="lg" className="animate-pulse" />
            <p className="text-muted-foreground text-sm">Loading...</p>
          </div>
        </div>
      )
    }
  }

  // A failed revalidation must not blank out a usable cached list (offline /
  // flaky network). Only surface the hard error when there's nothing to show.
  if (error && !displayWorkspaces?.length) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <p className="text-destructive">Failed to load workspaces</p>
          <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        </div>
      </div>
    )
  }

  // Auto-redirect when there's exactly one workspace and no pending
  // invitations. Gate on the *authoritative* network list, not the cached
  // one: redirecting off the cache while `pendingInvitations` is still its
  // pre-fetch `[]` default would skip the invitation UI for a returning user
  // who has one workspace and a freshly-issued invite.
  if (workspaces?.length === 1 && pendingInvitations.length === 0 && !acceptingId) {
    return <Navigate to={`/w/${workspaces[0].id}`} replace />
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-8">
        <ThreaLogo size="lg" />
        <div className="text-center">
          <h1 className="text-xl font-medium">Welcome, {user?.name || "User"}</h1>
          <p className="mt-1 text-muted-foreground text-sm">Select a workspace to continue</p>
        </div>

        {pendingInvitations.length > 0 && (
          <div className="flex flex-col gap-2 w-64">
            <p className="text-sm font-medium text-muted-foreground">Pending invitations</p>
            {pendingInvitations.map((invitation) => (
              <div key={invitation.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                <span className="truncate text-sm">{invitation.workspaceName}</span>
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => handleAcceptInvitation(invitation.id)}
                  disabled={acceptingId === invitation.id}
                >
                  {acceptingId === invitation.id ? "Accepting..." : "Accept"}
                </Button>
              </div>
            ))}
            {acceptError && <p className="text-sm text-destructive">{acceptError}</p>}
          </div>
        )}

        {displayWorkspaces && displayWorkspaces.length > 0 && (
          <div className="flex flex-col gap-2">
            {displayWorkspaces.map((workspace) => (
              <Button key={workspace.id} asChild variant="outline" className="w-64 justify-start">
                <Link to={`/w/${workspace.id}`}>
                  <span className="truncate">{workspace.name}</span>
                </Link>
              </Button>
            ))}
          </div>
        )}

        <form onSubmit={handleCreateWorkspace} className="flex flex-col gap-3 w-64">
          <Input
            type="text"
            placeholder="New workspace name"
            value={newWorkspaceName}
            onChange={(e) => setNewWorkspaceName(e.target.value)}
            disabled={createWorkspace.isPending}
          />
          {showRegionPicker && (
            <Select value={selectedRegion} onValueChange={setSelectedRegion} disabled={createWorkspace.isPending}>
              <SelectTrigger>
                <SelectValue placeholder="Select region" />
              </SelectTrigger>
              <SelectContent>
                {regions.map((region) => (
                  <SelectItem key={region} value={region}>
                    {formatRegion(region)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button type="submit" disabled={!newWorkspaceName.trim() || createWorkspace.isPending}>
            {createWorkspace.isPending ? "Creating..." : "Create Workspace"}
          </Button>
          {createWorkspaceErrorMessage && <p className="text-sm text-destructive">{createWorkspaceErrorMessage}</p>}
        </form>
      </div>
    </div>
  )
}
