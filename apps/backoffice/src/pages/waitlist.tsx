import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Search } from "lucide-react"
import { Badge, type BadgeProps } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { PageHeader } from "@/components/layout/page-header"
import { backofficeKeys, getWaitlist, type WaitlistEntry } from "@/api/backoffice"

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  })
}

/** Known statuses get a deliberate colour; anything unexpected falls back to outline. */
const STATUS_VARIANT: Record<string, BadgeProps["variant"]> = {
  pending: "secondary",
  invited: "default",
}

function statusVariant(status: string): BadgeProps["variant"] {
  return STATUS_VARIANT[status] ?? "outline"
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
    <div className="mx-auto flex max-w-5xl flex-col gap-8">
      <PageHeader
        title="Waitlist"
        description="Everyone who signed up from the marketing site, newest first. Counts are exact; the list shows the most recent signups."
      />

      {/* Bordered band of exact counts — mirrors the Overview stat band. */}
      <div className="grid grid-cols-1 divide-y border-y sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <Stat label="Total signups" value={stats?.total ?? null} />
        <Stat label="Pending" value={stats?.pending ?? null} highlight={!!stats && stats.pending > 0} />
        <Stat label="Invited" value={stats?.invited ?? null} />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by email, source, or status"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {waitlistQ.isLoading ? "Loading…" : `${filtered.length} of ${entries.length}`}
        </span>
      </div>

      <WaitlistList loading={waitlistQ.isLoading} entries={filtered} query={query} />

      {truncated ? (
        <p className="text-xs text-muted-foreground">
          Showing the {entries.length} most recent signups of {stats?.total ?? entries.length} total.
        </p>
      ) : null}
    </div>
  )
}

function Stat({ label, value, highlight }: { label: string; value: number | null; highlight?: boolean }) {
  return (
    <div className="flex flex-col gap-1 px-1 py-5 sm:px-6">
      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{label}</span>
      <span
        className={
          highlight
            ? "text-3xl font-semibold tabular-nums text-primary"
            : "text-3xl font-semibold tabular-nums text-foreground"
        }
      >
        {value == null ? <span className="text-muted-foreground">—</span> : value}
      </span>
    </div>
  )
}

function WaitlistList({ loading, entries, query }: { loading: boolean; entries: WaitlistEntry[]; query: string }) {
  if (loading) {
    return <div className="border-y px-1 py-10 text-center text-sm text-muted-foreground">Loading signups…</div>
  }

  if (entries.length === 0) {
    return (
      <div className="border-y px-1 py-10 text-center text-sm text-muted-foreground">
        {query ? "No signups match that query." : "No one has joined the waitlist yet."}
      </div>
    )
  }

  return (
    <ul className="divide-y border-y">
      {entries.map((entry) => (
        <li key={entry.id} className="flex items-center justify-between gap-4 py-4 pl-4 pr-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="truncate text-sm font-medium text-foreground">{entry.email}</span>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <span className="truncate">{entry.source ?? "direct"}</span>
              <span className="text-muted-foreground/50">·</span>
              <span className="tabular-nums">{formatDate(entry.createdAt)}</span>
            </div>
          </div>
          <Badge variant={statusVariant(entry.status)} className="shrink-0 capitalize">
            {entry.status}
          </Badge>
        </li>
      ))}
    </ul>
  )
}
