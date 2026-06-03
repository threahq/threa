import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { ChevronRight, Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { PageHeader } from "@/components/layout/page-header"
import { formatDate } from "@/lib/format"
import { backofficeKeys, listWorkspaces, type WorkspaceSummary } from "@/api/backoffice"

function matches(workspace: WorkspaceSummary, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  return (
    workspace.name.toLowerCase().includes(needle) ||
    workspace.slug.toLowerCase().includes(needle) ||
    workspace.id.toLowerCase().includes(needle) ||
    workspace.region.toLowerCase().includes(needle)
  )
}

export function WorkspacesPage() {
  const workspacesQ = useQuery({
    queryKey: backofficeKeys.workspaces,
    queryFn: listWorkspaces,
  })

  const [query, setQuery] = useState("")
  const filtered = useMemo(() => (workspacesQ.data ?? []).filter((w) => matches(w, query)), [workspacesQ.data, query])

  const total = workspacesQ.data?.length ?? 0
  const countLabel = workspacesQ.isLoading ? "Loading…" : `${filtered.length} of ${total}`

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8">
      <PageHeader
        title="Workspaces"
        description="Every workspace in the control-plane registry. Click a row to see the owner and details."
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name, slug, id, or region"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {countLabel}
        </span>
      </div>

      <WorkspaceList loading={workspacesQ.isLoading} workspaces={filtered} query={query} />
    </div>
  )
}

function WorkspaceList({
  loading,
  workspaces,
  query,
}: {
  loading: boolean
  workspaces: WorkspaceSummary[]
  query: string
}) {
  if (loading) {
    return <div className="border-y px-1 py-10 text-center text-sm text-muted-foreground">Loading workspaces…</div>
  }

  if (workspaces.length === 0) {
    return (
      <div className="border-y px-1 py-10 text-center text-sm text-muted-foreground">
        {query ? "No workspaces match that query." : "The registry is empty."}
      </div>
    )
  }

  return (
    <ul className="divide-y border-y">
      {workspaces.map((w) => (
        <li key={w.id}>
          <Link
            to={`/workspaces/${w.id}`}
            className="group flex items-center justify-between gap-4 border-l-[3px] border-l-transparent py-4 pl-4 pr-3 transition-colors hover:border-l-primary hover:bg-accent/30"
          >
            <div className="flex min-w-0 flex-col gap-1">
              <span className="truncate text-sm font-medium text-foreground">{w.name}</span>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span className="truncate">@{w.slug}</span>
                <span className="text-muted-foreground/50">·</span>
                <span>{w.region}</span>
                <span className="text-muted-foreground/50">·</span>
                <span className="tabular-nums">
                  {w.memberCount} {w.memberCount === 1 ? "member" : "members"}
                </span>
                <span className="hidden text-muted-foreground/50 md:inline">·</span>
                <span className="hidden tabular-nums md:inline">{formatDate(w.createdAt)}</span>
              </div>
            </div>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
          </Link>
        </li>
      ))}
    </ul>
  )
}
