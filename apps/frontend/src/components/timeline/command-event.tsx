import { useState } from "react"
import type { StreamEvent, CommandDispatchedPayload, CommandCompletedPayload, CommandFailedPayload } from "@threa/types"
import { Loader2, CheckCircle, XCircle, ChevronRight, X } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { useFormattedDate } from "@/hooks"
import { stripMarkdownToInline } from "@/lib/markdown"
import { useCommandDispatchCancellation } from "@/hooks/use-command-dispatch-queue"

interface CommandEventProps {
  /** All events for this command, grouped by commandId */
  events: StreamEvent[]
}

type CommandStatus = "running" | "completed" | "failed"

/**
 * Renders grouped command events as a collapsible lifecycle timeline.
 * Command events are author-only — filtering happens in EventItem.
 */
export function CommandEvent({ events }: CommandEventProps) {
  const [isOpen, setIsOpen] = useState(false)
  const { formatTime } = useFormattedDate()

  // Find the dispatched event (always first) and terminal event (completed/failed)
  const dispatchedEvent = events.find((e) => e.eventType === "command_dispatched")
  const completedEvent = events.find((e) => e.eventType === "command_completed")
  const failedEvent = events.find((e) => e.eventType === "command_failed")
  const localStatus = (dispatchedEvent as (StreamEvent & { _status?: string }) | undefined)?._status
  const cancellation = useCommandDispatchCancellation(
    dispatchedEvent?.streamId ?? "",
    (dispatchedEvent?.payload as CommandDispatchedPayload | undefined)?.commandId ?? "",
    localStatus
  )

  if (!dispatchedEvent) return null

  const dispatchedPayload = dispatchedEvent.payload as CommandDispatchedPayload
  let status: CommandStatus = "running"
  if (failedEvent) {
    status = "failed"
  } else if (completedEvent) {
    status = "completed"
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="flex min-h-10 items-center rounded hover:bg-muted/50">
        <CollapsibleTrigger asChild>
          <button className="flex min-h-10 min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 pr-1 text-sm text-muted-foreground transition-colors">
            <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`} />
            <StatusIcon status={status} />
            <span className="min-w-0 flex-1 text-left">
              <code className="font-mono text-xs bg-muted text-primary font-bold px-1 py-0.5 rounded">
                /{dispatchedPayload.name}
              </code>
              {dispatchedPayload.args && (
                <span className="text-muted-foreground/70 ml-1">{truncateArgs(dispatchedPayload.args)}</span>
              )}
              <StatusLabel status={status} failedPayload={failedEvent?.payload as CommandFailedPayload | undefined} />
            </span>
            <span className="text-xs text-muted-foreground/50">{formatTime(new Date(dispatchedEvent.createdAt))}</span>
          </button>
        </CollapsibleTrigger>
        {cancellation.canCancel && (
          <button
            type="button"
            className="mr-1 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={status === "failed" ? "Remove failed command" : "Cancel pending command"}
            title={status === "failed" ? "Remove failed command" : "Cancel pending command"}
            onClick={() => void cancellation.cancel()}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <CollapsibleContent>
        <div className="ml-8 border-l border-muted pl-3 py-1 space-y-1">
          {events.map((event) => (
            <TimelineEntry key={event.id} event={event} formatTime={formatTime} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function StatusIcon({ status }: { status: CommandStatus }) {
  switch (status) {
    case "running":
      return <Loader2 className="h-3.5 w-3.5 animate-spin" />
    case "completed":
      return <CheckCircle className="h-3.5 w-3.5 text-green-500" />
    case "failed":
      return <XCircle className="h-3.5 w-3.5 text-destructive" />
  }
}

function StatusLabel({ status, failedPayload }: { status: CommandStatus; failedPayload?: CommandFailedPayload }) {
  switch (status) {
    case "running":
      return <span className="text-muted-foreground/70 ml-2">running...</span>
    case "completed":
      return <span className="text-green-600 ml-2">completed</span>
    case "failed":
      return <span className="text-destructive ml-2">failed: {failedPayload?.error ?? "unknown error"}</span>
  }
}

function TimelineEntry({ event, formatTime }: { event: StreamEvent; formatTime: (date: Date) => string }) {
  const time = formatTime(new Date(event.createdAt))

  switch (event.eventType) {
    case "command_dispatched": {
      const p = event.payload as CommandDispatchedPayload
      return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="w-12 text-muted-foreground/50">{time}</span>
          <span>
            Command dispatched:{" "}
            <code className="font-mono bg-muted text-primary font-bold px-1 rounded">/{p.name}</code>
            {p.args && <span className="text-muted-foreground/70"> {stripMarkdownToInline(p.args)}</span>}
          </span>
        </div>
      )
    }

    case "command_completed": {
      const p = event.payload as CommandCompletedPayload
      const resultText = p.result ? formatResult(p.result) : null
      return (
        <div className="flex items-center gap-2 text-xs text-green-600">
          <span className="w-12 text-muted-foreground/50">{time}</span>
          <span>Completed{resultText && `: ${resultText}`}</span>
        </div>
      )
    }

    case "command_failed": {
      const p = event.payload as CommandFailedPayload
      return (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <span className="w-12 text-muted-foreground/50">{time}</span>
          <span>Failed: {p.error}</span>
        </div>
      )
    }

    default:
      return null
  }
}

// Args are command markdown — a picked mention arrives as a pointer link
// (`[@bot](bot:bot_x)`, INV-64) that must strip to `@bot` for display (INV-60).
function truncateArgs(args: string, maxLength = 50): string {
  const inline = stripMarkdownToInline(args)
  if (inline.length <= maxLength) return inline
  return inline.slice(0, maxLength) + "..."
}

function formatResult(result: unknown): string {
  if (typeof result === "string") return result
  if (typeof result === "object" && result !== null) {
    const r = result as Record<string, unknown>
    if ("personas" in r && "topic" in r) {
      const personas = r.personas as string[]
      return `${personas.join(", ")} discussing "${r.topic}"`
    }
  }
  return ""
}
