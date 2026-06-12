import { useQuery } from "@tanstack/react-query"
import { Link, NavLink, Outlet, useParams } from "react-router-dom"
import { ChevronLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { PageHeader } from "@/components/layout/page-header"
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
    <div className="mx-auto flex max-w-5xl flex-col gap-8">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/workspaces">
            <ChevronLeft className="size-4" />
            Back to workspaces
          </Link>
        </Button>
      </div>

      <Body loading={query.isLoading} error={query.error} workspace={query.data} workspaceId={id} />
    </div>
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
  if (loading) {
    return <div className="border-y px-1 py-10 text-center text-sm text-muted-foreground">Loading workspace…</div>
  }
  if (error) {
    const notFound = ApiError.isApiError(error) && error.status === 404
    return (
      <div className="border-y px-1 py-10 text-center text-sm text-muted-foreground">
        {notFound ? "That workspace doesn't exist." : "Couldn't load workspace."}
      </div>
    )
  }
  if (!workspace) return null
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={workspace.name} description={`@${workspace.slug}`} />
      {workspaceId ? <TabNav id={workspaceId} /> : null}
      <Outlet />
    </div>
  )
}

function TabNav({ id }: { id: string }) {
  return (
    <nav className="-mt-2 flex gap-6 border-b text-sm">
      <TabLink to={`/workspaces/${id}`} end>
        Overview
      </TabLink>
      <TabLink to={`/workspaces/${id}/members`} end>
        Members
      </TabLink>
      <TabLink to={`/workspaces/${id}/flags`} end>
        Feature flags
      </TabLink>
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
          "-mb-px border-b-2 pb-2.5 transition-colors",
          isActive
            ? "border-foreground font-medium text-foreground"
            : "border-transparent text-muted-foreground hover:text-foreground"
        )
      }
    >
      {children}
    </NavLink>
  )
}
