import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Badge, type BadgeProps } from "@/components/ui/badge"
import { Page } from "@/components/layout/page"
import { PageHeader } from "@/components/layout/page-header"
import { ListPlaceholder, MetaLine, ROW_PADDING, RowList, RowText } from "@/components/layout/rows"
import { Stat, StatGrid } from "@/components/layout/stat"
import { SearchField } from "@/components/search-field"
import { cn } from "@/lib/utils"
import { formatDate } from "@/lib/format"
import { backofficeKeys, getWaitlist, type WaitlistEntry } from "@/api/backoffice"

/** Known statuses get a deliberate colour; anything unexpected falls back to outline. */
const STATUS_TONE: Record<string, BadgeProps["tone"]> = {
  pending: "warning",
  invited: "primary",
}

function statusTone(status: string): BadgeProps["tone"] {
  return STATUS_TONE[status] ?? "neutral"
}

function matches(entry: WaitlistEntry, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  return (
    entry.email.toLowerCase().includes(needle) ||
    entry.status.toLowerCase().includes(needle) ||
    (entry.source?.toLowerCase().includes(needle) ?? false)
  )
}

export function WaitlistPage() {
  const waitlistQ = useQuery({
    queryKey: backofficeKeys.waitlist,
    queryFn: getWaitlist,
  })

  const [query, setQuery] = useState("")
  const entries = waitlistQ.data?.entries ?? []
  const filtered = useMemo(() => entries.filter((e) => matches(e, query)), [entries, query])

  const stats = waitlistQ.data?.stats
  const truncated = waitlistQ.data?.truncated ?? false

  return (
    <Page>
      <PageHeader title="Waitlist" description="Everyone who signed up from the marketing site, newest first." />

      <StatGrid>
        <Stat label="Total signups" value={stats?.total ?? null} />
        <Stat label="Pending" value={stats?.pending ?? null} highlight={!!stats && stats.pending > 0} />
        <Stat label="Invited" value={stats?.invited ?? null} />
      </StatGrid>

      <div className="flex flex-col gap-3">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search by email, source, or status"
          count={waitlistQ.isLoading ? "Loading…" : `${filtered.length} of ${entries.length}`}
        />
        <WaitlistList loading={waitlistQ.isLoading} entries={filtered} query={query} />
        {truncated ? (
          <p className="text-sm text-muted-foreground">
            Showing the {entries.length} most recent signups of {stats?.total ?? entries.length} total.
          </p>
        ) : null}
      </div>
    </Page>
  )
}

function WaitlistList({ loading, entries, query }: { loading: boolean; entries: WaitlistEntry[]; query: string }) {
  if (loading) return <ListPlaceholder>Loading signups…</ListPlaceholder>
  if (entries.length === 0) {
    return (
      <ListPlaceholder>
        {query ? "No signups match that query." : "No one has joined the waitlist yet."}
      </ListPlaceholder>
    )
  }

  return (
    <RowList>
      {entries.map((entry) => (
        <li key={entry.id} className={cn("flex min-h-14 items-center gap-4", ROW_PADDING)}>
          <RowText
            title={entry.email}
            meta={
              <MetaLine
                parts={[entry.source ?? "direct", <span className="tabular-nums">{formatDate(entry.createdAt)}</span>]}
              />
            }
          />
          <Badge tone={statusTone(entry.status)} className="capitalize">
            {entry.status}
          </Badge>
        </li>
      ))}
    </RowList>
  )
}
