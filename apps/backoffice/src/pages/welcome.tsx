import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { ArrowRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Page } from "@/components/layout/page"
import { PageHeader } from "@/components/layout/page-header"
import { Section } from "@/components/layout/section"
import { LinkRow, ListPlaceholder, MetaLine, RowList, RowText } from "@/components/layout/rows"
import { Stat, StatGrid } from "@/components/layout/stat"
import { useUser } from "@/auth"
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
    <Page>
      <PageHeader title={<>Welcome{displayName ? `, ${displayName}` : ""}.</>} />

      <StatGrid>
        <Stat to="/workspaces" label="Workspaces" value={workspaceCount} />
        <Stat
          to="/invites/workspace-owners"
          label="Pending invites"
          value={pendingCount}
          highlight={!!pendingCount && pendingCount > 0}
        />
        <Stat to="/invites/workspace-owners" label="Accepted invites" value={acceptedCount} />
      </StatGrid>

      {pendingInvites.length > 0 ? (
        <Section
          label={`Needs attention · ${pendingInvites.length}`}
          description="Invitations still waiting on the recipient."
          actions={<ViewAllLink to="/invites/workspace-owners" />}
        >
          <RowList>
            {pendingInvites.slice(0, RECENT_LIMIT).map((inv) => (
              <LinkRow key={inv.id} to="/invites/workspace-owners">
                <RowText
                  title={inv.email}
                  badges={
                    <Badge tone="primary" className="capitalize">
                      {inv.state}
                    </Badge>
                  }
                  meta={
                    <MetaLine parts={[`Sent ${formatDate(inv.createdAt)}`, `expires ${formatDate(inv.expiresAt)}`]} />
                  }
                />
              </LinkRow>
            ))}
          </RowList>
        </Section>
      ) : null}

      <Section label="Recent workspaces" actions={<ViewAllLink to="/workspaces" />}>
        <RecentWorkspaceList loading={workspacesQ.isLoading} workspaces={recentWorkspaces} />
      </Section>
    </Page>
  )
}

function ViewAllLink({ to }: { to: string }) {
  return (
    <Link
      to={to}
      className="group inline-flex min-h-9 items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
    >
      View all
      <ArrowRight aria-hidden className="size-3.5 transition-transform group-hover:translate-x-0.5" />
    </Link>
  )
}

function RecentWorkspaceList({ loading, workspaces }: { loading: boolean; workspaces: WorkspaceSummary[] }) {
  if (loading) return <ListPlaceholder>Loading workspaces…</ListPlaceholder>
  if (workspaces.length === 0) return <ListPlaceholder>No workspaces yet.</ListPlaceholder>
  return (
    <RowList>
      {workspaces.map((w) => (
        <LinkRow key={w.id} to={`/workspaces/${w.id}`}>
          <RowText
            title={w.name}
            meta={<MetaLine parts={[`@${w.slug}`, w.region, `created ${formatDate(w.createdAt)}`]} />}
          />
        </LinkRow>
      ))}
    </RowList>
  )
}
