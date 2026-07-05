import { useRef, useEffect } from "react"
import type { AgentSessionStep, AgentStepType } from "@threa/types"
import type { StreamingSubstep } from "@/hooks/use-agent-trace"
import { TraceStep } from "./trace-step"
import { cn } from "@/lib/utils"

interface TraceStepListProps {
  steps: AgentSessionStep[]
  highlightMessageId: string | null
  workspaceId: string
  streamId: string
  /** Viewer's user id, threaded to each step for decrypting sealed (enclave) content. */
  userId?: string | null
  /**
   * Live substep history keyed by step type. Merged with each step's persisted
   * substeps inside `TraceStep` so the phase timeline shows both pre-refresh
   * history and post-refresh streaming entries.
   */
  streamingSubsteps?: Partial<Record<AgentStepType, StreamingSubstep[]>>
  /**
   * Callback to gracefully stop the running session. Passed only while the
   * session is running; `TraceStep` renders a Stop button in the in-progress
   * step's header so the user can interrupt from inside the trace dialog.
   */
  onStopSession?: () => void
}

export function TraceStepList({
  steps,
  highlightMessageId,
  workspaceId,
  streamId,
  userId,
  streamingSubsteps,
  onStopSession,
}: TraceStepListProps) {
  const highlightRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (highlightMessageId && highlightRef.current) {
      setTimeout(() => {
        highlightRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })
      }, 100)
    }
  }, [highlightMessageId, steps])

  if (steps.length === 0) {
    return <div className="p-6 text-center text-muted-foreground">No steps recorded yet.</div>
  }

  return (
    <div>
      {steps.map((step) => {
        const isHighlighted = step.messageId === highlightMessageId
        // Only pass live substeps to the in-progress step. Substeps are keyed by
        // step type, so without this guard a completed workspace_search step
        // (e.g. search_users) would incorrectly show the phases from an
        // in-flight workspace_research tool that shares the same step type.
        const isInProgress = !step.completedAt
        const liveSubsteps = isInProgress ? streamingSubsteps?.[step.stepType] : undefined
        return (
          <div
            key={step.id}
            ref={isHighlighted ? highlightRef : undefined}
            className={cn(isHighlighted && "ring-2 ring-primary/20 ring-inset")}
          >
            <TraceStep
              step={step}
              workspaceId={workspaceId}
              streamId={streamId}
              userId={userId}
              liveSubsteps={liveSubsteps}
              onStopSession={onStopSession}
            />
          </div>
        )
      })}
    </div>
  )
}
