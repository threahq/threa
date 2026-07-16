import { useRef, useEffect, useState, type ReactNode } from "react"
import { PI_TOOL_TRACE_FORMAT, type AgentSessionStep, type AgentStepType } from "@threa/types"
import type { StreamingSubstep } from "@/hooks/use-agent-trace"
import { TraceStep } from "./trace-step"
import { cn } from "@/lib/utils"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ChevronRight, Loader2, TerminalSquare } from "lucide-react"

interface TraceStepListProps {
  steps: AgentSessionStep[]
  highlightMessageId: string | null
  workspaceId: string
  streamId: string
  userId?: string | null
  streamingSubsteps?: Partial<Record<AgentStepType, StreamingSubstep[]>>
  isSessionRunning?: boolean
  onStopSession?: () => void
  onSteerSession?: () => void
}

type TraceStepDisplayItem =
  | { kind: "step"; step: AgentSessionStep }
  | { kind: "phase"; id: string; thinking?: AgentSessionStep; tools: AgentSessionStep[] }

export function TraceStepList({
  steps,
  highlightMessageId,
  workspaceId,
  streamId,
  userId,
  streamingSubsteps,
  isSessionRunning = false,
  onStopSession,
  onSteerSession,
}: TraceStepListProps) {
  const highlightRef = useRef<HTMLDivElement>(null)
  const displayItems = groupBotWorkByThinking(steps)
  let latestPhaseIndex = -1
  for (let index = displayItems.length - 1; index >= 0; index--) {
    if (displayItems[index]?.kind === "phase") {
      latestPhaseIndex = index
      break
    }
  }
  const newerThinkingExists = displayItems
    .slice(latestPhaseIndex + 1)
    .some((item) => item.kind === "step" && item.step.stepType === "thinking")
  const latestPhase = latestPhaseIndex >= 0 ? displayItems[latestPhaseIndex] : undefined
  const activePhaseId =
    isSessionRunning && latestPhase?.kind === "phase" && !newerThinkingExists ? latestPhase.id : null

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

  const renderStep = (step: AgentSessionStep) => {
    const isHighlighted = step.messageId === highlightMessageId
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
          onSteerSession={onSteerSession}
        />
      </div>
    )
  }

  return (
    <div>
      {displayItems.map((item) => {
        if (item.kind === "step") return renderStep(item.step)
        return (
          <div key={item.id}>
            {item.thinking && renderStep(item.thinking)}
            <BotWorkingSection
              tools={item.tools}
              active={item.id === activePhaseId}
              nested={Boolean(item.thinking)}
              highlightedMessageId={highlightMessageId}
              renderStep={renderStep}
            />
          </div>
        )
      })}
    </div>
  )
}

function BotWorkingSection({
  tools,
  active,
  nested,
  highlightedMessageId,
  renderStep,
}: {
  tools: AgentSessionStep[]
  active: boolean
  nested: boolean
  highlightedMessageId: string | null
  renderStep: (step: AgentSessionStep) => ReactNode
}) {
  const errorCount = tools.filter((step) => step.stepType === "tool_error").length
  const containsHighlight = tools.some((step) => step.messageId === highlightedMessageId)
  const [detailsOpen, setDetailsOpen] = useState(errorCount > 0 || containsHighlight)
  const lastTool = tools.at(-1)!
  const preview = active ? toolPreview(lastTool.content) : null

  useEffect(() => {
    if (errorCount > 0 || containsHighlight) setDetailsOpen(true)
  }, [errorCount, containsHighlight])
  const toolLabel = `${tools.length} tool ${tools.length === 1 ? "call" : "calls"}`
  const errorLabel = errorCount > 0 ? ` • ${errorCount} ${errorCount === 1 ? "error" : "errors"}` : ""

  return (
    <div className={cn("border-b border-border bg-muted/15", nested && "ml-6 border-l")}>
      <div className="flex items-start gap-2 px-5 py-3.5">
        <div className="mt-0.5 rounded-md bg-muted px-2 py-1 text-muted-foreground">
          {active ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <TerminalSquare className="h-3.5 w-3.5" />}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Working</div>
          <div className="text-xs text-muted-foreground">
            {toolLabel}
            {errorLabel}
          </div>
          {preview && (
            <div className="rounded-md border border-border/70 bg-background/70 px-3 py-2 text-xs">
              <div className="break-all font-mono text-foreground/90">{preview.headline}</div>
              {preview.detail && <div className="mt-1 truncate text-muted-foreground">{preview.detail}</div>}
            </div>
          )}
        </div>
      </div>
      <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
        <CollapsibleTrigger className="group flex min-h-11 w-full items-center gap-1.5 px-5 py-2 text-left text-xs text-muted-foreground hover:text-foreground transition-colors">
          <ChevronRight className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-90" />
          Full tool details
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border bg-background/70">{tools.map(renderStep)}</div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

function groupBotWorkByThinking(steps: AgentSessionStep[]): TraceStepDisplayItem[] {
  const items: TraceStepDisplayItem[] = []
  let thinking: AgentSessionStep | undefined
  let tools: AgentSessionStep[] = []

  const flush = () => {
    if (tools.length > 0) {
      items.push({ kind: "phase", id: `${thinking?.id ?? "work"}-${tools[0]!.id}`, thinking, tools })
    } else if (thinking) {
      items.push({ kind: "step", step: thinking })
    }
    thinking = undefined
    tools = []
  }

  for (const step of steps) {
    if (step.stepType === "thinking") {
      flush()
      thinking = step
      continue
    }
    if (isLowLevelBotToolStep(step)) {
      tools.push(step)
      continue
    }
    flush()
    items.push({ kind: "step", step })
  }
  flush()

  return items
}

function isLowLevelBotToolStep(step: AgentSessionStep): boolean {
  if (step.stepType !== "tool_call" && step.stepType !== "tool_error") return false
  if (!step.completedAt) return false
  return parseToolTrace(step.content)?.format === PI_TOOL_TRACE_FORMAT || looksLikeTruncatedToolTrace(step.content)
}

function toolPreview(content: unknown): { headline: string; detail: string | null } | null {
  const parsed = parseToolTrace(content)
  if (!parsed) {
    return looksLikeTruncatedToolTrace(content) ? { headline: "Tool trace was truncated", detail: null } : null
  }
  const headline = typeof parsed.headline === "string" && parsed.headline.trim() ? parsed.headline.trim() : "Tool call"
  const sections: unknown[] = Array.isArray(parsed.sections) ? parsed.sections : []
  const lastSection = sections.at(-1)
  const body =
    lastSection && typeof lastSection === "object" && "body" in lastSection && typeof lastSection.body === "string"
      ? lastSection.body
      : ""
  const firstLine = body
    .split("\n")
    .map((line: string) => line.trim())
    .find(Boolean)
  let detail = firstLine ?? null
  if (detail && detail.length > 140) detail = `${detail.slice(0, 137)}...`
  return { headline, detail }
}

function parseToolTrace(content: unknown): Record<string, unknown> | null {
  if (content && typeof content === "object") return content as Record<string, unknown>
  if (typeof content !== "string") return null
  try {
    const parsed = JSON.parse(content)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function looksLikeTruncatedToolTrace(content: unknown): boolean {
  return (
    typeof content === "string" && new RegExp(`^\\s*\\{\\s*"format"\\s*:\\s*"${PI_TOOL_TRACE_FORMAT}"`).test(content)
  )
}
