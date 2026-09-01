import { AlertCircle, Filter, Inbox } from "lucide-react"
import type { AgentOutcomeKind } from "@threa/types"
import { Button } from "@/components/ui/button"
import type { OutcomesFilters } from "./use-outcomes-url-state"

type EmptyKind = "empty" | "filtered-empty" | "error"

interface OutcomesEmptyProps {
  kind: EmptyKind
  filters: OutcomesFilters
  onClearFilters?: () => void
  onWidenScope?: () => void
}

const KIND_NOUN: Record<AgentOutcomeKind, string> = {
  follow_up: "follow-ups",
  delegation: "delegations",
  subagent: "subagents",
}

const CHROME: Record<EmptyKind, { icon: typeof Inbox; accent: string }> = {
  empty: { icon: Inbox, accent: "bg-primary/10 text-primary" },
  "filtered-empty": { icon: Filter, accent: "bg-muted text-muted-foreground" },
  error: { icon: AlertCircle, accent: "bg-destructive/10 text-destructive" },
}

const FIXED_COPY: Record<"empty" | "error", { title: string; body: string }> = {
  empty: {
    title: "Nothing scheduled yet",
    body: "Follow-ups your companion schedules, tasks it delegates, and models it hands work to show up here.",
  },
  error: {
    title: "Couldn't load the agenda",
    body: "Something went wrong loading this list. Try again in a moment.",
  },
}

function filteredCopy(filters: OutcomesFilters): { title: string; body: string } {
  const noun = filters.kind ? KIND_NOUN[filters.kind] : "outcomes"
  if (filters.queryText.trim()) {
    return { title: "No matches", body: `No ${noun} match “${filters.queryText.trim()}” in this scope.` }
  }
  if (filters.state === "outstanding") {
    return { title: "Nothing outstanding", body: `No ${noun} are still waiting to happen here.` }
  }
  if (filters.state === "settled") {
    return { title: "Nothing settled yet", body: `No ${noun} have finished, fired, or been cancelled here.` }
  }
  return { title: "Nothing in this scope", body: `No ${noun} here yet. Try widening to the whole workspace.` }
}

export function OutcomesEmpty({ kind, filters, onClearFilters, onWidenScope }: OutcomesEmptyProps) {
  const copy = kind === "filtered-empty" ? filteredCopy(filters) : FIXED_COPY[kind]
  const { icon: Icon, accent } = CHROME[kind]

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center"
      data-testid="outcomes-empty"
    >
      <div className={`flex h-12 w-12 items-center justify-center rounded-card ${accent}`}>
        <Icon className="h-5 w-5" aria-hidden />
      </div>
      <div className="space-y-1">
        <div className="text-sm font-medium">{copy.title}</div>
        <p className="max-w-[30ch] text-xs text-muted-foreground">{copy.body}</p>
      </div>
      {kind === "filtered-empty" ? (
        <div className="flex gap-2">
          {onClearFilters ? (
            <Button size="sm" variant="outline" onClick={onClearFilters}>
              Clear filters
            </Button>
          ) : null}
          {onWidenScope ? (
            <Button size="sm" onClick={onWidenScope}>
              Search the workspace
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
