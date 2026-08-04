import { useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { agentFollowUpsApi } from "@/api/agent-follow-ups"
import { delegationsApi } from "@/api/delegations"
import { Button } from "@/components/ui/button"
import { useAsyncAction } from "@/hooks/use-async-action"
import { useFormattedDate } from "@/hooks"
import { useStreamName } from "@/hooks/use-stream-name"
import { agentOutcomeKeys } from "@/hooks/use-agent-outcomes"
import { OUTCOME_KIND_LABEL, type OutcomeItem } from "@/lib/agent-outcomes/items"
import { cn } from "@/lib/utils"

interface OutcomesDetailProps {
  workspaceId: string
  item: OutcomeItem | null
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm">{value}</div>
    </div>
  )
}

export function OutcomesDetail({ workspaceId, item }: OutcomesDetailProps) {
  const { formatFull } = useFormattedDate()
  const streamName = useStreamName(workspaceId, item?.streamId ?? "", "noun")
  const queryClient = useQueryClient()

  const invalidate = () => queryClient.invalidateQueries({ queryKey: agentOutcomeKeys.all })

  const cancel = useAsyncAction(
    async () => {
      if (!item) return
      if (item.kind === "follow_up") {
        const { cancelled } = await agentFollowUpsApi.cancel(workspaceId, item.id)
        if (!cancelled) toast.info("This follow-up already ran or was cancelled")
      } else {
        const { cancelled } = await delegationsApi.cancel(workspaceId, item.id)
        if (!cancelled) toast.info("This delegation already finished or was cancelled")
      }
      await invalidate()
    },
    { errorMessage: "Couldn't cancel" }
  )

  const markDone = useAsyncAction(
    async () => {
      if (!item) return
      const { completed } = await delegationsApi.markDone(workspaceId, item.id)
      if (!completed) toast.info("This delegation already finished or was cancelled")
      await invalidate()
    },
    { errorMessage: "Couldn't mark it done" }
  )

  if (!item) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
        Select a follow-up or delegation to see its detail.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4" data-testid="outcomes-detail">
      <div className="flex items-start gap-2">
        <h2 className="min-w-0 flex-1 text-sm font-semibold">{item.title}</h2>
        <span
          className={cn(
            "shrink-0 rounded px-1 py-px text-[10px] font-semibold uppercase tracking-wide",
            item.statusPillClass
          )}
        >
          {item.statusLabel}
        </span>
      </div>

      <div className="mt-4 grid gap-3">
        <Field label="Kind" value={OUTCOME_KIND_LABEL[item.kind]} />
        <Field
          label="Stream"
          value={
            <Link to={`/w/${workspaceId}/s/${item.streamId}`} className="underline-offset-2 hover:underline">
              {streamName ?? "this stream"}
            </Link>
          }
        />
        {item.scheduledFor ? <Field label="Scheduled for" value={formatFull(new Date(item.scheduledFor))} /> : null}
        <Field label="Created" value={formatFull(new Date(item.createdAt))} />
        <Field label="Last change" value={formatFull(new Date(item.statusChangedAt))} />
        {item.claimedByLabel ? <Field label="Claimed by" value={item.claimedByLabel} /> : null}
        {item.statusNote ? <Field label="Note" value={item.statusNote} /> : null}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {item.anchorPath ? (
          <Button asChild size="sm" variant="outline">
            <Link to={item.anchorPath}>Open in stream</Link>
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">No card to open — its source event is gone.</span>
        )}
        {item.canMarkDone ? (
          <Button size="sm" variant="outline" onClick={markDone.run} disabled={markDone.pending}>
            Mark done
          </Button>
        ) : null}
        {item.canCancel ? (
          <Button size="sm" variant="ghost" onClick={cancel.run} disabled={cancel.pending}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  )
}
