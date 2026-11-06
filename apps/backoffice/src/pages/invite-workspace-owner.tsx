import { useMemo, useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { Ban } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge, type BadgeProps } from "@/components/ui/badge"
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
import { InlineBanner } from "@/components/inline-banner"
import { Page } from "@/components/layout/page"
import { PageHeader } from "@/components/layout/page-header"
import { Section } from "@/components/layout/section"
import { CARD_CLASS, ListPlaceholder, ROW_PADDING, RowList, RowText } from "@/components/layout/rows"
import { cn } from "@/lib/utils"
import { readApiError } from "@/api/client"
import {
  backofficeKeys,
  createWorkspaceOwnerInvitation,
  listWorkspaceOwnerInvitations,
  resendWorkspaceOwnerInvitation,
  revokeWorkspaceOwnerInvitation,
  type WorkspaceOwnerInvitation,
} from "@/api/backoffice"
import { formatDateTime } from "@/lib/format"

const STATE_TONE: Record<WorkspaceOwnerInvitation["state"], BadgeProps["tone"]> = {
  pending: "primary",
  accepted: "success",
  revoked: "destructive",
  expired: "neutral",
}

function timestampLabel(invitation: WorkspaceOwnerInvitation): string {
  if (invitation.state === "accepted" && invitation.acceptedAt) {
    return `Accepted ${formatDateTime(invitation.acceptedAt)}`
  }
  if (invitation.state === "revoked" && invitation.revokedAt) {
    return `Revoked ${formatDateTime(invitation.revokedAt)}`
  }
  if (invitation.state === "pending") {
    return `Expires ${formatDateTime(invitation.expiresAt)}`
  }
  return `Expired ${formatDateTime(invitation.expiresAt)}`
}

export function InviteWorkspaceOwnerPage() {
  const queryClient = useQueryClient()
  const [email, setEmail] = useState("")
  // Controlled-by-target pattern: opening the dialog = setting a target.
  // Closing it (cancel, overlay click, confirm) = clearing the target.
  const [revokeTarget, setRevokeTarget] = useState<WorkspaceOwnerInvitation | null>(null)

  const invitationsQ = useQuery({
    queryKey: backofficeKeys.invitations,
    queryFn: listWorkspaceOwnerInvitations,
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: backofficeKeys.invitations })

  const createMutation = useMutation({
    mutationFn: (payload: string) => createWorkspaceOwnerInvitation(payload),
    onSuccess: () => {
      setEmail("")
      invalidate()
    },
  })

  const resendMutation = useMutation({
    mutationFn: (id: string) => resendWorkspaceOwnerInvitation(id),
    onSuccess: () => invalidate(),
  })

  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeWorkspaceOwnerInvitation(id),
    onSuccess: () => invalidate(),
  })

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!email) return
    createMutation.mutate(email)
  }

  const handleConfirmRevoke = () => {
    if (!revokeTarget) return
    revokeMutation.mutate(revokeTarget.id)
    setRevokeTarget(null)
  }

  const { pending, history } = useMemo(() => {
    const data = invitationsQ.data ?? []
    const sorted = [...data].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    return {
      pending: sorted.filter((i) => i.state === "pending"),
      history: sorted.filter((i) => i.state !== "pending"),
    }
  }, [invitationsQ.data])

  const createError = readApiError(createMutation.error)
  const resendError = readApiError(resendMutation.error)
  const revokeError = readApiError(revokeMutation.error)

  // Track which invitation is currently being mutated so only its row shows a
  // disabled state (rather than disabling the whole list while one request is
  // in flight).
  let busyId: string | null = null
  if (resendMutation.isPending) busyId = resendMutation.variables ?? null
  else if (revokeMutation.isPending) busyId = revokeMutation.variables ?? null

  return (
    <Page>
      <PageHeader
        title="Workspace owner invitations"
        description="Send a Threa invitation via WorkOS. When the invitee accepts and signs in, they can create their own workspace."
      />

      <Section label="New invitation">
        <form onSubmit={handleSubmit} className={cn(CARD_CLASS, "flex flex-col gap-3 p-4")}>
          <Label htmlFor="email">Email</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="owner@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={createMutation.isPending}
              className="sm:max-w-md"
            />
            <Button type="submit" disabled={createMutation.isPending || !email}>
              {createMutation.isPending ? "Sending…" : "Send invitation"}
            </Button>
          </div>

          {createMutation.isSuccess ? (
            <InlineBanner tone="success">
              Invitation sent to <span className="font-medium">{createMutation.data.email}</span>.
            </InlineBanner>
          ) : null}

          {createError ? <InlineBanner tone="error">{createError}</InlineBanner> : null}
        </form>
      </Section>

      {/* Row-level error banners live here so they don't reflow the list. */}
      {resendError || revokeError ? (
        <div className="flex flex-col gap-2">
          {resendError ? <InlineBanner tone="error">Couldn't resend invitation: {resendError}</InlineBanner> : null}
          {revokeError ? <InlineBanner tone="error">Couldn't revoke invitation: {revokeError}</InlineBanner> : null}
        </div>
      ) : null}

      <Section label={`Pending · ${pending.length}`}>
        <InvitationList
          loading={invitationsQ.isLoading}
          invitations={pending}
          emptyCopy="No pending invitations."
          renderRow={(inv) => (
            <InvitationRow
              key={inv.id}
              invitation={inv}
              busy={busyId === inv.id}
              onResend={() => resendMutation.mutate(inv.id)}
              onRevoke={() => setRevokeTarget(inv)}
            />
          )}
        />
      </Section>

      <Section label={`History · ${history.length}`}>
        <InvitationList
          loading={invitationsQ.isLoading}
          invitations={history}
          emptyCopy="No accepted, revoked, or expired invitations yet."
          renderRow={(inv) => <InvitationRow key={inv.id} invitation={inv} />}
        />
      </Section>

      <ResponsiveAlertDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null)
        }}
      >
        <ResponsiveAlertDialogContent className="gap-5 border-t-4 border-t-destructive/70">
          <ResponsiveAlertDialogHeader>
            <div className="mb-1 flex justify-center sm:justify-start">
              <span className="inline-flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive ring-4 ring-destructive/5">
                <Ban className="size-6" strokeWidth={2.25} />
              </span>
            </div>
            <ResponsiveAlertDialogTitle className="text-xl">Revoke this invitation?</ResponsiveAlertDialogTitle>
            <ResponsiveAlertDialogDescription>
              {revokeTarget ? (
                <>
                  The invitation for <span className="font-medium text-foreground">{revokeTarget.email}</span> will stop
                  working the moment you confirm. You can always send a fresh one later.
                </>
              ) : null}
            </ResponsiveAlertDialogDescription>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>Keep invitation</ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={handleConfirmRevoke}
            >
              Yes, revoke it
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </Page>
  )
}

function InvitationList({
  loading,
  invitations,
  emptyCopy,
  renderRow,
}: {
  loading: boolean
  invitations: WorkspaceOwnerInvitation[]
  emptyCopy: string
  renderRow: (invitation: WorkspaceOwnerInvitation) => React.ReactNode
}) {
  if (loading) return <ListPlaceholder>Loading invitations…</ListPlaceholder>
  if (invitations.length === 0) return <ListPlaceholder>{emptyCopy}</ListPlaceholder>
  return <RowList>{invitations.map(renderRow)}</RowList>
}

function InvitationRow({
  invitation,
  busy,
  onResend,
  onRevoke,
}: {
  invitation: WorkspaceOwnerInvitation
  busy?: boolean
  onResend?: () => void
  onRevoke?: () => void
}) {
  const hasActions = onResend && onRevoke
  return (
    <li className={cn("flex min-h-14 flex-col gap-2 sm:flex-row sm:items-center sm:gap-4", ROW_PADDING)}>
      <RowText
        title={invitation.email}
        badges={
          <Badge tone={STATE_TONE[invitation.state]} className="capitalize">
            {invitation.state}
          </Badge>
        }
        meta={
          <>
            {timestampLabel(invitation)}
            {invitation.workspaces.length > 0 ? (
              <>
                <span className="px-1.5 text-muted-foreground/50">·</span>
                <WorkspaceLinks workspaces={invitation.workspaces} />
              </>
            ) : null}
          </>
        }
      />
      {hasActions ? (
        <div className="-ml-3 flex shrink-0 items-center gap-1 sm:ml-0">
          <Button size="sm" variant="ghost" onClick={onResend} disabled={busy}>
            Resend
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onRevoke}
            disabled={busy}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            Revoke
          </Button>
        </div>
      ) : null}
    </li>
  )
}

function WorkspaceLinks({ workspaces }: { workspaces: WorkspaceOwnerInvitation["workspaces"] }) {
  return (
    <span>
      Joined{" "}
      {workspaces.map((ws, i) => (
        <span key={ws.id}>
          <Link to={`/workspaces/${ws.id}`} className="text-primary underline-offset-2 hover:underline">
            {ws.name}
          </Link>
          {i < workspaces.length - 1 ? ", " : null}
        </span>
      ))}
    </span>
  )
}
