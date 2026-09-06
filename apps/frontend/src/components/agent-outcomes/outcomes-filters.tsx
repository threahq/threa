import { Hash, X } from "lucide-react"
import { AGENT_OUTCOME_KINDS, type AgentOutcomeKind, type AgentOutcomeState } from "@threahq/types"
import { Badge } from "@/components/ui/badge"
import { useStreamName } from "@/hooks/use-stream-name"
import { OUTCOME_KIND_PLURAL } from "@/lib/agent-outcomes/items"
import { cn } from "@/lib/utils"
import type { OutcomesFilters as OutcomesFiltersValue } from "./use-outcomes-url-state"

interface OutcomesFiltersProps {
  workspaceId: string
  filters: OutcomesFiltersValue
  onUpdate: (next: Partial<OutcomesFiltersValue>) => void
}

/**
 * Chips, not tabs: state and kind are independent narrowings of one interleaved
 * list, so Outstanding has to be able to show a running delegation next to a
 * follow-up firing tonight.
 */
const STATE_CHIPS: Array<{ value: AgentOutcomeState; label: string }> = [
  { value: "outstanding", label: "Outstanding" },
  { value: "settled", label: "Settled" },
  { value: "all", label: "All" },
]

// Derived, never listed: a kind added to the constant gets its chip for free
// instead of silently becoming unfilterable (INV-31/33).
const KIND_CHIPS: Array<{ value: AgentOutcomeKind; label: string }> = AGENT_OUTCOME_KINDS.map((value) => ({
  value,
  label: OUTCOME_KIND_PLURAL[value],
}))

function ToggleChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-transparent bg-muted text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
    </button>
  )
}

function ScopeChip({
  workspaceId,
  streamId,
  onRemove,
}: {
  workspaceId: string
  streamId: string
  onRemove: () => void
}) {
  const name = useStreamName(workspaceId, streamId, "noun")

  return (
    <Badge variant="secondary" className="gap-1 pr-1">
      <Hash className="h-3 w-3" />
      <span className="max-w-[12rem] truncate">{name ?? "this stream"}</span>
      <button
        type="button"
        className="rounded-full p-0.5 transition-colors hover:bg-foreground/10 hover:text-foreground"
        onClick={onRemove}
        aria-label={`Remove ${name ?? "stream"} scope`}
      >
        <X className="h-3 w-3" />
      </button>
    </Badge>
  )
}

export function OutcomesFilters({ workspaceId, filters, onUpdate }: OutcomesFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 py-2" data-testid="outcomes-chips">
      {STATE_CHIPS.map((chip) => (
        <ToggleChip
          key={chip.value}
          label={chip.label}
          active={filters.state === chip.value}
          onClick={() => onUpdate({ state: chip.value, selectedOutcomeId: null })}
        />
      ))}
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      {KIND_CHIPS.map((chip) => (
        <ToggleChip
          key={chip.value}
          label={chip.label}
          active={filters.kind === chip.value}
          onClick={() => onUpdate({ kind: filters.kind === chip.value ? null : chip.value, selectedOutcomeId: null })}
        />
      ))}
      {filters.streamIds.map((streamId) => (
        <ScopeChip
          key={streamId}
          workspaceId={workspaceId}
          streamId={streamId}
          onRemove={() =>
            onUpdate({ streamIds: filters.streamIds.filter((id) => id !== streamId), selectedOutcomeId: null })
          }
        />
      ))}
    </div>
  )
}
