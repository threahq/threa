import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { ArrowRight, ChevronRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { PageHeader } from "@/components/layout/page-header"
import { Section } from "@/components/layout/section"
import { useUser } from "@/auth"
import { cn } from "@/lib/utils"
import { formatDate } from "@/lib/format"
import {
  backofficeKeys,
  listWorkspaceOwnerInvitations,
  listWorkspaces,
  type WorkspaceOwnerInvitation,
  type WorkspaceSummary,
} from "@/api/backoffice"

const RECENT_LIMIT = 5

function countByState(
  invitations: WorkspaceOwnerInvitation[] | undefined,
  state: WorkspaceOwnerInvitation["state"]
): number {
  return invitations?.filter((i) => i.state === state).length ?? 0
}

export function WelcomePage() {
  const user = useUser()
  const displayName = user?.name || user?.email

  const workspacesQ = useQuery({
    queryKey: backofficeKeys.workspaces,
    queryFn: listWorkspaces,
  })
  const invitesQ = useQuery({
    queryKey: backofficeKeys.invitations,
    queryFn: listWorkspaceOwnerInvitations,
  })

  const workspaceCount = workspacesQ.isLoading ? null : (workspacesQ.data?.length ?? 0)
  const pendingCount = invitesQ.isLoading ? null : countByState(invitesQ.data, "pending")
  const acceptedCount = invitesQ.isLoading ? null : countByState(invitesQ.data, "accepted")

  const pendingInvites = useMemo(
    () =>
      (invitesQ.data ?? [])
        .filter((i) => i.state === "pending")
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [invitesQ.data]
  )

  const recentWorkspaces = useMemo(
    () =>
      (workspacesQ.data ?? [])
        .slice()
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, RECENT_LIMIT),
    [workspacesQ.data]
  )

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-10">
      <PageHeader title={<>Welcome{displayName ? `, ${displayName}` : ""}.</>} />

      {/* Bordered band of numbers — each cell is a real link to its surface. */}
      <div className="grid grid-cols-1 divide-y border-y sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <StatLink to="/workspaces" label="Workspaces" value={workspaceCount} />
        <StatLink
          to="/invites/workspace-owners"
          label="Pending invites"
          value={pendingCount}
          highlight={!!pendingCount && pendingCount > 0}
        />
        <StatLink to="/invites/workspace-owners" label="Accepted invites" value={acceptedCount} />
      </div>

      {pendingInvites.length > 0 ? (
        <Section
          label={`Needs attention · ${pendingInvites.length}`}
          description="Invitations still waiting on the recipient. Jump in to resend or revoke."
          actions={<ViewAllLink to="/invites/workspace-owners" />}
        >
          <ul className="divide-y border-y">
            {pendingInvites.slice(0, RECENT_LIMIT).map((inv) => (
              <li key={inv.id}>
                <Link
                  to="/invites/workspace-owners"
                  className="group flex items-center justify-between gap-4 border-l-[3px] border-l-transparent py-3 pl-4 pr-3 transition-colors hover:border-l-primary hover:bg-accent/30"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{inv.email}</span>
                      <Badge variant="default" className="capitalize">
                        {inv.state}
                      </Badge>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      Sent {formatDate(inv.createdAt)} · expires {formatDate(inv.expiresAt)}
                    </span>
                  </div>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section
        label="Recent workspaces"
        description="Newest registrations in the control-plane registry."
        actions={<ViewAllLink to="/workspaces" />}
      >
        <RecentWorkspaceList loading={workspacesQ.isLoading} workspaces={recentWorkspaces} />
      </Section>
    </div>
  )
}

function StatLink({
  to,
  label,
  value,
  highlight,
}: {
  to: string
  label: string
  value: number | null
  highlight?: boolean
}) {
  return (
    <Link to={to} className="group flex flex-col gap-1 px-1 py-5 transition-colors hover:bg-accent/30 sm:px-6">
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{label}</span>
        <ArrowRight className="size-3 -translate-x-0.5 text-muted-foreground/40 opacity-0 transition-all group-hover:translate-x-0 group-hover:text-muted-foreground group-hover:opacity-100" />
      </div>
      <span className={cn("text-3xl font-semibold tabular-nums", highlight ? "text-primary" : "text-foreground")}>
        {value == null ? <span className="text-muted-foreground">—</span> : value}
      </span>
    </Link>
  )
}

function ViewAllLink({ to }: { to: string }) {
  return (
    <Link
      to={to}
      className="group inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline"
    >
      View all
      <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
    </Link>
  )
}

function RecentWorkspaceList({ loading, workspaces }: { loading: boolean; workspaces: WorkspaceSummary[] }) {
  if (loading) {
    return <div className="border-y px-1 py-6 text-center text-xs text-muted-foreground">Loading…</div>
  }
  if (workspaces.length === 0) {
    return <div className="border-y px-1 py-6 text-center text-xs text-muted-foreground">No workspaces yet.</div>
  }
  return (
    <ul className="divide-y border-y">
      {workspaces.map((w) => (
        <li key={w.id}>
          <Link
            to={`/workspaces/${w.id}`}
            className="group flex items-center justify-between gap-4 border-l-[3px] border-l-transparent py-3 pl-4 pr-3 transition-colors hover:border-l-primary hover:bg-accent/30"
          >
            <div className="flex min-w-0 flex-col gap-1">
              <span className="truncate text-sm font-medium text-foreground">{w.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                @{w.slug} · {w.region} · created {formatDate(w.createdAt)}
              </span>
            </div>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
          </Link>
        </li>
      ))}
    </ul>
  )
}
