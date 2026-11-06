import { useQuery } from "@tanstack/react-query"
import { Link, NavLink, Outlet, useParams } from "react-router-dom"
import { ChevronLeft } from "lucide-react"
import { Page } from "@/components/layout/page"
import { PageHeader } from "@/components/layout/page-header"
import { ListPlaceholder, MetaLine } from "@/components/layout/rows"
import { backofficeKeys, getBackofficeConfig, getWorkspace, type WorkspaceDetail } from "@/api/backoffice"
import { ApiError } from "@/api/client"
import { cn } from "@/lib/utils"

/**
 * Shell for `/workspaces/:id/*`. Fetches the workspace once at the layout level so
 * every tab can read it from the cache, and renders the header + tab nav. Per
 * INV-59 the active tab is derived from the URL path segment, not from local
 * state — refresh and shared links land users on the same tab.
 */
export function WorkspaceDetailLayout() {
  const { id } = useParams<{ id: string }>()
  const query = useQuery({
    queryKey: id ? backofficeKeys.workspace(id) : ["backoffice", "workspaces", "missing"],
    queryFn: () => {
      if (!id) throw new Error("Missing workspace id")
      return getWorkspace(id)
    },
    enabled: !!id,
  })

  // Backoffice config is loaded here so the overview tab can render external-id
  // links without re-fetching. Cached forever — config rarely changes.
  useQuery({
    queryKey: backofficeKeys.config,
    queryFn: getBackofficeConfig,
    staleTime: Infinity,
  })

  return (
    <Page>
      <Body loading={query.isLoading} error={query.error} workspace={query.data} workspaceId={id} />
    </Page>
  )
}

function Body({
  loading,
  error,
  workspace,
  workspaceId,
}: {
  loading: boolean
  error: unknown
  workspace: WorkspaceDetail | undefined
  workspaceId: string | undefined
}) {
  if (loading) return <ListPlaceholder>Loading workspace…</ListPlaceholder>
  if (error) {
    const notFound = ApiError.isApiError(error) && error.status === 404
    return <ListPlaceholder>{notFound ? "That workspace doesn't exist." : "Couldn't load workspace."}</ListPlaceholder>
  }
  if (!workspace) return null
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Link
            to="/workspaces"
            className="-ml-1 inline-flex min-h-9 w-fit items-center gap-1 rounded-md px-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft aria-hidden className="size-4" />
            Workspaces
          </Link>
          <PageHeader
            title={workspace.name}
            description={<MetaLine parts={[`@${workspace.slug}`, workspace.region]} />}
          />
        </div>
        {workspaceId ? <TabNav id={workspaceId} /> : null}
      </div>
      <Outlet />
    </div>
  )
}

function TabNav({ id }: { id: string }) {
  return (
    <nav aria-label="Workspace sections" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <div className="flex min-w-max gap-6 border-b text-sm">
        <TabLink to={`/workspaces/${id}`} end>
          Overview
        </TabLink>
        <TabLink to={`/workspaces/${id}/members`} end>
          Members
        </TabLink>
        <TabLink to={`/workspaces/${id}/flags`} end>
          Feature flags
        </TabLink>
        <TabLink to={`/workspaces/${id}/ai-spend`} end>
          AI spend
        </TabLink>
      </div>
    </nav>
  )
}

function TabLink({ to, end, children }: { to: string; end?: boolean; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "-mb-px flex min-h-11 items-center border-b-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          isActive
            ? "border-primary font-medium text-foreground"
            : "border-transparent text-muted-foreground hover:text-foreground"
        )
      }
    >
      {children}
    </NavLink>
  )
}
