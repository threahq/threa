import { useRef, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react"
import { PI_TOOL_TRACE_FORMAT, PiToolTraceSectionLabels, type AgentSessionStep, type AgentStepType } from "@threa/types"
import type { StreamingSubstep } from "@/hooks/use-agent-trace"
import { getCachedDecryption, getDecryptCacheVersion, subscribeDecryptCacheVersion } from "@/lib/crypto/decrypt-cache"
import { TraceStep } from "./trace-step"
import { cn } from "@/lib/utils"
import { STEP_DISPLAY_CONFIG } from "@/lib/step-config"
import { useIsMobile } from "@/hooks/use-mobile"
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
/** A phone fits two chips on the wrapped line; a third truncates all of them to noise. */
const MAX_TOOL_CHIPS_MOBILE = 2

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
  | { kind: "phase"; id: string; tools: AgentSessionStep[] }

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
  // Grouping and the collapsed-row chips read a sealed step's plaintext out of
  // the module-global decrypt cache (the same entry `TraceStep` fills a level
  // down), so the list needs to re-render when one lands. One global-version
  // subscription for the whole list, not one per step: a trace is a bounded
  // list rendered inside a dialog, and per-key subscriptions here would fan out
  // across every step for a value only the group summary reads.
  useSyncExternalStore(subscribeDecryptCacheVersion, getDecryptCacheVersion, getDecryptCacheVersion)
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
  highlightedMessageId,
  renderStep,
}: {
  tools: AgentSessionStep[]
  active: boolean
  highlightedMessageId: string | null
  renderStep: (step: AgentSessionStep) => ReactNode
}) {
  const isMobile = useIsMobile()
  const errorCount = tools.filter((step) => step.stepType === "tool_error").length
  const containsHighlight = tools.some((step) => step.messageId === highlightedMessageId)
  const [detailsOpen, setDetailsOpen] = useState(errorCount > 0)
  const open = containsHighlight || detailsOpen
  const lastTool = tools.at(-1)!
  const preview = active ? toolPreview(resolveStepContent(lastTool)) : null

  useEffect(() => {
    if (errorCount > 0) setDetailsOpen(true)
  }, [errorCount])
  // A tool call is two steps on the wire (the use and its result), so the count
  // and the chips are derived from paired calls, never from step rows.
  const calls = useMemo(() => deriveToolCalls(tools), [tools])
  const callCount = calls.length
  const toolLabel = `${callCount} tool ${callCount === 1 ? "call" : "calls"}`
  const allChips = dedupeChips(calls)
  const chips = allChips.slice(0, isMobile ? MAX_TOOL_CHIPS_MOBILE : MAX_TOOL_CHIPS)
  const hiddenChipCount = allChips.length - chips.length

  return (
    <div
      className="border-b border-border"
      style={{
        background: workHue(open ? 0.05 : 0.035),
        borderLeft: `2px solid ${workHue(open ? 0.55 : 0.3)}`,
      }}
    >
      <Collapsible open={open} onOpenChange={setDetailsOpen}>
        {/* pl-[22px] + the 2px rail lands the icon on the same left edge as the
            step pills in the rows above and below. */}
        <CollapsibleTrigger className="group flex min-h-11 w-full flex-wrap items-center gap-x-2.5 gap-y-1 py-2 pl-[22px] pr-4 text-left transition-colors hover:bg-foreground/[0.03]">
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
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{toolLabel}</span>
          {errorCount > 0 && (
            <span className="shrink-0 text-[11px] font-medium text-destructive">
              {errorCount} {errorCount === 1 ? "error" : "errors"}
            </span>
          )}

          {/* The collapsed row carries the work itself: the live tool headline
              while the phase runs, else a chip per call. Once expanded the rows
              below say it in full, so the chips step aside.

              Both wrap to a full-width second line below `sm` (order-last keeps
              them under the label + chevron); on `sm` and up they take the rest
              of the first line. A phone can't fit a headline and its output on
              one 44px line without truncating both to nothing. */}
          {preview && (
            <span className="order-last flex min-w-0 basis-full flex-col gap-0.5 sm:order-none sm:basis-0 sm:flex-1 sm:flex-row sm:items-baseline sm:gap-2">
              <span className="truncate font-mono text-[11.5px] text-foreground/90">{preview.headline}</span>
              {preview.detail && <span className="truncate text-[11px] text-muted-foreground">{preview.detail}</span>}
            </span>
          )}
          {!preview && !open && (
            <span className="order-last flex min-w-0 basis-full items-center gap-1.5 overflow-hidden sm:order-none sm:basis-0 sm:flex-1">
              {chips.map((chip) => (
                <ToolChip key={chip.key} chip={chip} />
              ))}
              {hiddenChipCount > 0 && (
                <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">+{hiddenChipCount}</span>
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

function ToolChip({ chip }: { chip: ToolChipItem }) {
  const isError = chip.isError
  const label = chip.count > 1 ? `${chip.headline} ×${chip.count}` : chip.headline
  return (
    <span
      className={cn(
        "max-w-[42vw] shrink-0 truncate rounded-full px-2 py-0.5 font-mono text-[10.5px] leading-[1.45] sm:max-w-[180px]",
        isError ? "bg-destructive/10 text-destructive ring-1 ring-inset ring-destructive/25" : "text-foreground/75"
      )}
      style={isError ? undefined : { background: workHue(0.09), boxShadow: `inset 0 0 0 1px ${workHue(0.22)}` }}
    >
      {label}
    </span>
  )
}

interface ToolCall {
  /** Identity for React keys: the id of the step that opened the call. */
  key: string
  headline: string
  isError: boolean
}

type ToolChipItem = ToolCall & { count: number }

/**
 * One entry per tool call the agent actually made.
 *
 * A single call reaches the trace as TWO steps sharing one headline — the tool
 * use and its result — so counting `tool_call` rows doubles the number the
 * agent would recognise. The payload carries no tool id (the redactor strips
 * arguments, not just values), so the pairing identity is the section label:
 * Arguments/Details opens a call, Output/Error output closes the open one with
 * the same headline. Steps carrying neither label (truncated or undecryptable
 * traces) fall back to collapsing a consecutive same-headline run into one call.
 */
function deriveToolCalls(tools: AgentSessionStep[]): ToolCall[] {
  const calls: ToolCall[] = []
  // Parallel tool batches arrive as [useA, useB, resA, resB], so a single open
  // slot mispairs them; results bind FIFO, headline match preferred.
  const openIndices: number[] = []

  for (const step of tools) {
    const content = resolveStepContent(step)
    const headline = toolPreview(content)?.headline ?? "Tool call"
    const role = toolStepRole(content)
    const isError = step.stepType === "tool_error"

    if (role === "result" && openIndices.length > 0) {
      const matchAt = openIndices.findIndex((index) => calls[index].headline === headline)
      const [closedIndex] = openIndices.splice(matchAt >= 0 ? matchAt : 0, 1)
      if (isError) calls[closedIndex].isError = true
      continue
    }
    if (role === "unknown" && openIndices.length === 0) {
      const last = calls.at(-1)
      if (last && last.headline === headline) {
        if (isError) last.isError = true
        continue
      }
    }
    calls.push({ key: step.id, headline, isError })
    if (role === "use") openIndices.push(calls.length - 1)
  }

  return calls
}

/** Consecutive identical calls become one chip carrying how many times it ran. */
function dedupeChips(calls: ToolCall[]): ToolChipItem[] {
  const chips: ToolChipItem[] = []
  for (const call of calls) {
    const last = chips.at(-1)
    if (last && last.headline === call.headline && last.isError === call.isError) {
      last.count += 1
      continue
    }
    chips.push({ ...call, count: 1 })
  }
  return chips
}

function toolStepRole(content: unknown): "use" | "result" | "unknown" {
  const parsed = parseToolTrace(content)
  const sections: unknown[] = Array.isArray(parsed?.sections) ? parsed.sections : []
  for (const section of sections) {
    if (!section || typeof section !== "object" || !("label" in section)) continue
    const label = section.label
    if (label === PiToolTraceSectionLabels.OUTPUT || label === PiToolTraceSectionLabels.ERROR_OUTPUT) return "result"
    if (label === PiToolTraceSectionLabels.ARGUMENTS || label === PiToolTraceSectionLabels.DETAILS) return "use"
  }
  return "unknown"
}

/**
 * A sealed step's `content` is undefined here — decryption happens inside
 * `TraceStep`, a level below the grouping. Read the same module-global cache
 * entry it fills so sealed traces group and chip like plaintext ones instead of
 * silently falling out of the Working section.
 */
function resolveStepContent(step: AgentSessionStep): unknown {
  if (step.content !== undefined && step.content !== null) return step.content
  const cached = getCachedDecryption(step.id)
  return cached?.status === "decrypted" ? cached.value?.contentMarkdown : undefined
}

function groupBotWorkByThinking(steps: AgentSessionStep[]): TraceStepDisplayItem[] {
  const items: TraceStepDisplayItem[] = []
  let activePhase: Extract<TraceStepDisplayItem, { kind: "phase" }> | null = null

  for (const step of steps) {
    if (step.stepType === "thinking") {
      items.push({ kind: "step", step })
      activePhase = null
      continue
    }
    if (isLowLevelBotToolStep(step)) {
      if (!activePhase) {
        activePhase = { kind: "phase", id: `work-${step.id}`, tools: [] }
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
  const content = resolveStepContent(step)
  return parseToolTrace(content)?.format === PI_TOOL_TRACE_FORMAT || looksLikeTruncatedToolTrace(content)
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
