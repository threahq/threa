import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Page } from "@/components/layout/page"
import { PageHeader } from "@/components/layout/page-header"
import { LinkRow, ListPlaceholder, MetaLine, RowList, RowText } from "@/components/layout/rows"
import { SearchField } from "@/components/search-field"
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
    <Page>
      <PageHeader title="Workspaces" description="Every workspace in the control-plane registry." />

      <div className="flex flex-col gap-3">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search by name, slug, id, or region"
          count={countLabel}
        />
        <WorkspaceList loading={workspacesQ.isLoading} workspaces={filtered} query={query} />
      </div>
    </Page>
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
  if (loading) return <ListPlaceholder>Loading workspaces…</ListPlaceholder>
  if (workspaces.length === 0) {
    return <ListPlaceholder>{query ? "No workspaces match that query." : "The registry is empty."}</ListPlaceholder>
  }

  return (
    <RowList>
      {workspaces.map((w) => (
        <LinkRow key={w.id} to={`/workspaces/${w.id}`}>
          <RowText
            title={w.name}
            meta={
              <MetaLine
                parts={[
                  `@${w.slug}`,
                  w.region,
                  <span className="tabular-nums">
                    {w.memberCount} {w.memberCount === 1 ? "member" : "members"}
                  </span>,
                  <span className="tabular-nums">{formatDate(w.createdAt)}</span>,
                ]}
              />
            }
          />
        </LinkRow>
      ))}
    </RowList>
  )
}
