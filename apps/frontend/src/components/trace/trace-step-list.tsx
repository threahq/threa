import { useRef, useEffect, useState, type ReactNode } from "react"
import { PI_TOOL_TRACE_FORMAT, type AgentSessionStep, type AgentStepType } from "@threa/types"
import type { StreamingSubstep } from "@/hooks/use-agent-trace"
import { TraceStep } from "./trace-step"
import { cn } from "@/lib/utils"
import { STEP_DISPLAY_CONFIG } from "@/lib/step-config"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ChevronRight, Loader2, TerminalSquare } from "lucide-react"

/**
 * Tool work borrows the `tool_call` hue so a Working group reads as the same
 * family as the rows it collapses — and as a different type from the thinking
 * (amber) and response (green) rows it sits between.
 */
const WORK_CONFIG = STEP_DISPLAY_CONFIG.tool_call
const workHue = (alpha?: number) =>
  `hsl(${WORK_CONFIG.hue} ${WORK_CONFIG.saturation}% ${WORK_CONFIG.lightness}%${alpha === undefined ? "" : ` / ${alpha}`})`

const MAX_TOOL_CHIPS = 3

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
  | { kind: "phase"; id: string; nested: boolean; tools: AgentSessionStep[] }

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
          <BotWorkingSection
            key={item.id}
            tools={item.tools}
            active={item.id === activePhaseId}
            nested={item.nested}
            highlightedMessageId={highlightMessageId}
            renderStep={renderStep}
          />
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
  const [detailsOpen, setDetailsOpen] = useState(errorCount > 0)
  const open = containsHighlight || detailsOpen
  const lastTool = tools.at(-1)!
  const preview = active ? toolPreview(lastTool.content) : null

  useEffect(() => {
    if (errorCount > 0) setDetailsOpen(true)
  }, [errorCount])
  const toolLabel = `${tools.length} tool ${tools.length === 1 ? "call" : "calls"}`
  const chips = tools.slice(0, MAX_TOOL_CHIPS)
  const overflow = tools.length - chips.length

  return (
    <div
      className={cn("border-b border-border", nested && "ml-6")}
      style={{
        background: workHue(open ? 0.05 : 0.035),
        borderLeft: `2px solid ${workHue(open ? 0.55 : 0.3)}`,
      }}
    >
      <Collapsible open={open} onOpenChange={setDetailsOpen}>
        <CollapsibleTrigger className="group flex min-h-11 w-full items-center gap-2.5 px-5 py-2 text-left transition-colors hover:bg-foreground/[0.03]">
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
            style={{ background: workHue(0.12), color: workHue(), boxShadow: `inset 0 0 0 1px ${workHue(0.22)}` }}
          >
            {active ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <TerminalSquare className="h-3.5 w-3.5" />}
          </span>
          <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: workHue() }}>
            Working
          </span>
          <span className="sr-only">{active ? "Working in progress" : "Working complete"}</span>
          {/* While a phase runs, a phone's width goes to the live preview, not
              the count — the preview names the tool the count only totals. */}
          <span className={cn("shrink-0 text-[11px] tabular-nums text-muted-foreground", preview && "max-sm:hidden")}>
            {toolLabel}
          </span>
          {errorCount > 0 && (
            <span className="shrink-0 text-[11px] font-medium text-destructive">
              {errorCount} {errorCount === 1 ? "error" : "errors"}
            </span>
          )}

          {/* The collapsed row carries the work itself: the live tool headline
              while the phase runs, else a chip per call. Once expanded the rows
              below say it in full, so the chips step aside. */}
          {preview && (
            <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
              <span className="truncate font-mono text-[11.5px] text-foreground/90">{preview.headline}</span>
              {preview.detail && <span className="truncate text-[11px] text-muted-foreground">{preview.detail}</span>}
            </span>
          )}
          {!preview && !open && (
            <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
              {chips.map((step) => (
                <ToolChip key={step.id} step={step} />
              ))}
              {overflow > 0 && (
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">+{overflow}</span>
              )}
            </span>
          )}

          <ChevronRight
            className="ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
            aria-hidden
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t bg-background/60" style={{ borderColor: workHue(0.18) }}>
            {tools.map(renderStep)}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

function ToolChip({ step }: { step: AgentSessionStep }) {
  const isError = step.stepType === "tool_error"
  const label = toolPreview(step.content)?.headline ?? "Tool call"
  return (
    <span
      className={cn(
        "max-w-[180px] shrink-0 truncate rounded-full px-2 py-0.5 font-mono text-[10.5px] leading-[1.45]",
        isError ? "bg-destructive/10 text-destructive ring-1 ring-inset ring-destructive/25" : "text-foreground/75"
      )}
      style={isError ? undefined : { background: workHue(0.09), boxShadow: `inset 0 0 0 1px ${workHue(0.22)}` }}
    >
      {label}
    </span>
  )
}

function groupBotWorkByThinking(steps: AgentSessionStep[]): TraceStepDisplayItem[] {
  const items: TraceStepDisplayItem[] = []
  let nested = false
  let activePhase: Extract<TraceStepDisplayItem, { kind: "phase" }> | null = null

  for (const step of steps) {
    if (step.stepType === "thinking") {
      items.push({ kind: "step", step })
      nested = true
      activePhase = null
      continue
    }
    if (isLowLevelBotToolStep(step)) {
      if (!activePhase) {
        activePhase = { kind: "phase", id: `${nested ? "nested" : "work"}-${step.id}`, nested, tools: [] }
        items.push(activePhase)
      }
      activePhase.tools.push(step)
      continue
    }
    items.push({ kind: "step", step })
  }

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
