import { Link } from "react-router-dom"
import {
  AgentReconsiderationDecisions,
  PI_TOOL_TRACE_FORMAT,
  PiToolTraceSectionLabels,
  type AgentSessionStep,
  type AgentStepType,
  type PiToolTraceSectionLabel,
  type TraceSource,
} from "@threa/types"
import { cn } from "@/lib/utils"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { RelativeTime } from "@/components/relative-time"
import { formatDuration } from "@/lib/dates"
import { STEP_DISPLAY_CONFIG, isAbortableStepType } from "@/lib/step-config"
import {
  ChevronRight,
  CircleSlash,
  Clock,
  ExternalLink,
  Loader2,
  MessageSquareReply,
  type LucideIcon,
} from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { FileText } from "lucide-react"
import { AttachmentPill } from "@/components/composer/attachment-pill"
import { formatContextRefLabel } from "@/lib/context-bag/format-label"
import { buildContextRefSourceHref } from "@/lib/context-bag/source-link"
import { stripMarkdownToInline } from "@/lib/markdown/strip"
import { useDecryptedStepContent } from "@/hooks/use-decrypted-step-content"
import { StopResearchButton } from "./stop-research-button"

interface TraceStepProps {
  step: AgentSessionStep
  workspaceId: string
  streamId: string
  /**
   * Viewer's user id, used to resolve the E2E session for decrypting sealed
   * (enclave) step content. Null/undefined for plaintext traces — the dialog
   * resolves it once via `useWorkspaceUserId` and threads it down.
   */
  userId?: string | null
  /**
   * Optional live substeps for an in-flight step (cleared on step completion).
   * Merged with any persisted substeps in `step.content` so the dialog can
   * show phases both from the pre-refresh history (persisted) and the live
   * socket stream (fresh). Dedupe is by `text`, which is unique per step.
   */
  liveSubsteps?: Array<{ text: string; at: string }>
  /**
   * When the step is in-flight and this tool supports graceful abort, this
   * callback is rendered as a Stop research button in the step header. The
   * trace dialog only passes this when `status === "running"` and for tool
   * types that opt in (workspace_search in V1).
   */
  onAbortResearch?: () => void
}

export function TraceStep({ step, workspaceId, streamId, userId, liveSubsteps, onAbortResearch }: TraceStepProps) {
  const config = STEP_DISPLAY_CONFIG[step.stepType]
  const Icon = config.icon

  // E2E (enclave) steps carry sealed content the browser decrypts here; plaintext
  // steps pass `step.content` straight through (status "plaintext").
  const decrypted = useDecryptedStepContent(step, workspaceId, streamId, userId ?? null)
  const effectiveContent = decrypted.content

  const isInProgress = !step.completedAt
  const duration = step.duration ? formatDuration(step.duration) : null
  // Sealed steps carry their citation sources INSIDE the decrypted payload
  // (E2EE-14); plaintext steps carry them on the cleartext `sources` column.
  // Key off what the payload holds, never off who produced the step.
  const effectiveSources = decrypted.status === "decrypted" ? decrypted.sources : step.sources
  const hasSources = effectiveSources && effectiveSources.length > 0
  const messageLink = step.messageId ? `/w/${workspaceId}/s/${streamId}?m=${step.messageId}` : null
  const hueColor = `hsl(${config.hue} ${config.saturation}% ${config.lightness}%)`

  // In-progress steps replace the default timestamp + duration right-slot with
  // a spinning loader + "Running…" label + optional Stop research button. The
  // stopPropagation prop is false here because TraceStep is not wrapped in a
  // clickable Link (the trace dialog body is scrollable content, not a link).
  const rightSlot = isInProgress ? (
    <>
      <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: hueColor }} />
      <span className="text-muted-foreground">Running…</span>
      {isAbortableStepType(step.stepType) && onAbortResearch && <StopResearchButton onClick={onAbortResearch} />}
    </>
  ) : undefined

  return (
    <div
      className="px-6 py-5 border-b border-border"
      style={{
        background: `hsl(${config.hue} ${config.saturation}% ${config.lightness}% / 0.03)`,
      }}
    >
      <StepHeader config={config} Icon={Icon} startedAt={step.startedAt} duration={duration} rightSlot={rightSlot} />

      {/*
        Render the body when there's content OR when the step is in-progress (so
        live substeps can render even before the first persisted substep lands).
        For sealed steps that can't be shown yet (locked / decrypting / failed),
        a notice stands in instead. Passing an empty string when there's no
        content lets the workspace_search case fall through to the "substeps
        only" branch via liveSubsteps.
      */}
      {decrypted.status === "locked" || decrypted.status === "pending" || decrypted.status === "failed" ? (
        <StepDecryptNotice status={decrypted.status} />
      ) : (
        (effectiveContent || isInProgress) && (
          <StepContent
            stepType={step.stepType}
            content={effectiveContent ?? ""}
            messageLink={messageLink}
            workspaceId={workspaceId}
            liveSubsteps={liveSubsteps}
            isInProgress={isInProgress}
          />
        )
      )}

      {hasSources && <SourceList sources={effectiveSources!} config={config} workspaceId={workspaceId} />}
    </div>
  )
}

/** Stand-in for a sealed step's body when it can't be shown (locked / decrypting / failed). */
const STEP_DECRYPT_NOTICE_TEXT: Record<"locked" | "pending" | "failed", string> = {
  locked: "Unlock this scratchpad to view this step",
  pending: "Decrypting…",
  failed: "Couldn't decrypt this step",
}

function StepDecryptNotice({ status }: { status: "locked" | "pending" | "failed" }) {
  return <div className="text-sm italic text-muted-foreground">{STEP_DECRYPT_NOTICE_TEXT[status]}</div>
}

interface StepHeaderProps {
  config: { label: string; hue: number; saturation: number; lightness: number }
  Icon: LucideIcon
  startedAt?: string
  duration?: string | null
  /**
   * Override for the right-hand slot. When provided, replaces the default
   * timestamp + duration display. Used by `InFlightStepCard` to show a
   * "Running…" indicator + Stop research button instead of a completion time.
   */
  rightSlot?: React.ReactNode
}

function StepHeader({ config, Icon, startedAt, duration, rightSlot }: StepHeaderProps) {
  return (
    <div className="flex items-center gap-2.5 mb-3">
      <div
        className="px-2.5 py-1 rounded-md text-[11px] font-semibold uppercase tracking-wide inline-flex items-center gap-1.5"
        style={{
          background: `hsl(${config.hue} ${config.saturation}% ${config.lightness}% / 0.15)`,
          color: `hsl(${config.hue} ${config.saturation}% ${config.lightness}%)`,
        }}
      >
        <Icon className="w-3.5 h-3.5" />
        {config.label}
      </div>
      <div className="flex items-center gap-2 ml-auto text-[11px] text-muted-foreground">
        {rightSlot ??
          (startedAt && (
            <>
              <RelativeTime date={startedAt} className="text-[11px] text-muted-foreground" />
              {duration && (
                <>
                  <span>•</span>
                  <span>{duration}</span>
                </>
              )}
            </>
          ))}
      </div>
    </div>
  )
}

/**
 * Parse structured JSON content, returning null if not valid JSON.
 *
 * Accepts both string content (the normal convention — JSONB string type
 * round-trips as a JS string via node-postgres) and object content (a
 * defensive path for any step rows whose content was written as a JSONB
 * object directly; node-postgres auto-parses these to JS objects). The
 * object path protects against crashes if any intermediate persistence
 * code-path forgets the pre-stringify convention.
 */
function parseStructuredContent(content: unknown): Record<string, unknown> | null {
  if (content && typeof content === "object") {
    return content as Record<string, unknown>
  }
  if (typeof content !== "string") return null
  try {
    const parsed = JSON.parse(content)
    if (typeof parsed === "object" && parsed !== null) return parsed
  } catch {
    // Not JSON — plain text content (e.g., LLM thinking output)
  }
  return null
}

/**
 * Coerce the step.content wire value into a string suitable for rendering as
 * a JSX child. The wire type says `string` but any historical row whose
 * content was persisted as a raw object (bypassing the pre-stringify
 * convention) would come back from the API as an object. Rendering that as a
 * JSX child throws "Objects are not valid as a React child" — this helper
 * normalises both cases to a safe string so the render path can't crash.
 */
function coerceContentToString(content: unknown): string {
  if (typeof content === "string") return content
  if (content == null) return ""
  try {
    return JSON.stringify(content)
  } catch {
    return ""
  }
}

function StepContent({
  stepType,
  content,
  messageLink,
  workspaceId,
  liveSubsteps,
  isInProgress,
}: {
  stepType: AgentStepType
  content: unknown
  messageLink: string | null
  workspaceId: string
  liveSubsteps?: Array<{ text: string; at: string }>
  isInProgress: boolean
}) {
  const structured = parseStructuredContent(content)
  const contentString = coerceContentToString(content)

  return (
    <div className="text-sm leading-relaxed">
      {renderStepContent(stepType, contentString, structured, messageLink, workspaceId, liveSubsteps, isInProgress)}
    </div>
  )
}

/** Message info as stored in context_received and reconsidering steps */
interface MessageInfo {
  messageId: string
  authorName: string
  authorType: "user" | "persona" | "system"
  changeType?: "message_created" | "message_edited" | "message_deleted"
  createdAt: string
  content: string
  isTrigger?: boolean
}

interface RerunContextInfo {
  cause: "invoking_message_edited" | "referenced_message_edited"
  editedMessageId: string
  editedMessageBefore?: string | null
  editedMessageAfter?: string | null
}

/**
 * Per-ref attached context the agent's turn was grounded in. Persisted on
 * the `context_received` step alongside the in-stream trigger so the trace
 * dialog can render the same chip the in-stream message shows AND list the
 * actual referenced messages — the trace exists to expose more than the
 * timeline does, not less.
 */
interface AttachedContextRefInfo {
  streamId: string
  fromMessageId: string | null
  toMessageId: string | null
  /** Cosmetic deep-link anchor; the focal message the discussion was started from. */
  originMessageId: string | null
  source: {
    displayName: string | null
    slug: string | null
    type: string
    itemCount: number
  }
  messages: Array<{
    messageId: string
    authorName: string
    createdAt: string
    content: string
  }>
}

interface AttachedContextInfo {
  refs: AttachedContextRefInfo[]
}

function renderStepContent(
  stepType: AgentStepType,
  content: string,
  structured: Record<string, unknown> | null,
  messageLink: string | null,
  workspaceId: string,
  liveSubsteps?: Array<{ text: string; at: string }>,
  isInProgress: boolean = false
): React.ReactNode {
  switch (stepType) {
    case "context_received": {
      if (structured && "messages" in structured) {
        const messages = structured.messages as MessageInfo[]
        const rerunContext = (structured.rerunContext as RerunContextInfo | undefined) ?? null
        const attachedContext = (structured.attachedContext as AttachedContextInfo | undefined) ?? null
        const triggerMessage = messages.find((m) => m.isTrigger)
        const contextMessages = messages.filter((m) => !m.isTrigger)

        return (
          <div className="space-y-3">
            {rerunContext && <RerunContextSummary rerunContext={rerunContext} />}

            {/* Trigger message - highlighted */}
            {triggerMessage && (
              <div>
                <div className="text-muted-foreground text-[11px] mb-1.5 font-medium">Triggered by:</div>
                <MessagePreview message={triggerMessage} highlight />
              </div>
            )}

            {/* Attached context bag — same pill the in-stream message shows,
                plus an expandable view of the actual referenced messages so
                the trace exposes what was fed to the model. */}
            {attachedContext && attachedContext.refs.length > 0 && (
              <AttachedContextSection attachedContext={attachedContext} workspaceId={workspaceId} />
            )}

            {/* Context messages */}
            {contextMessages.length > 0 && (
              <div>
                <div className="text-muted-foreground text-[11px] mb-1.5">Recent context:</div>
                <div className="space-y-1.5">
                  {contextMessages.map((msg) => (
                    <MessagePreview key={msg.messageId} message={msg} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      }
      return <span className="text-muted-foreground">Processing messages...</span>
    }

    case "thinking": {
      if (structured && "toolPlan" in structured) {
        const tools = structured.toolPlan as string[]
        return <span className="text-muted-foreground">Planning to use: {tools.join(", ")}</span>
      }
      return <MarkdownContent content={content} className="text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0" />
    }

    case "reconsidering": {
      if (structured && structured.decision === AgentReconsiderationDecisions.KEPT_PREVIOUS_RESPONSE) {
        const reason = typeof structured.reason === "string" ? structured.reason : null
        return (
          <div className="space-y-2">
            <div className="text-muted-foreground">
              Kept the previous response unchanged after reconsidering the updated context.
            </div>
            {reason && (
              <div className="rounded bg-muted/50 px-3 py-2 text-xs">
                <span className="font-medium">Reason:</span> {reason}
              </div>
            )}
          </div>
        )
      }

      if (structured && "draftResponse" in structured) {
        const draft = structured.draftResponse as string
        const newMessages = (structured.newMessages as MessageInfo[]) ?? []
        const hasMutatedMessages = newMessages.some(
          (message) => message.changeType === "message_edited" || message.changeType === "message_deleted"
        )
        return (
          <div className="space-y-3">
            {/* New messages that arrived */}
            {newMessages.length > 0 && (
              <div>
                <div className="text-muted-foreground text-[11px] mb-1.5 font-medium">
                  {hasMutatedMessages
                    ? "Message changes arrived:"
                    : `New ${newMessages.length === 1 ? "message" : "messages"} arrived:`}
                </div>
                <div className="space-y-1.5">
                  {newMessages.map((msg) => (
                    <MessagePreview key={msg.messageId} message={msg} highlight />
                  ))}
                </div>
              </div>
            )}

            {/* Draft response that's being reconsidered */}
            <div>
              <div className="text-muted-foreground text-[11px] mb-1.5">Draft being reconsidered:</div>
              <div className="rounded bg-muted/50 px-3 py-2 text-xs italic">
                <MarkdownContent
                  content={draft.length > 200 ? draft.slice(0, 200) + "..." : draft}
                  className="text-xs"
                />
              </div>
            </div>
          </div>
        )
      }
      return <span className="text-muted-foreground">Reconsidering response due to new context</span>
    }

    case "web_search":
      return (
        <span>
          <strong>Query:</strong> "{content}"
        </span>
      )

    case "workspace_search": {
      // Merge persisted substeps (from step.content JSON, written by the
      // session-trace-observer on each tool:progress event and baked in at
      // tool:complete by workspace-research-tool's formatContent) with live
      // substeps from the socket stream. Persisted wins the base order (it's
      // the authoritative history); live entries that aren't yet in persisted
      // are appended. Dedupe is by `text`, which is unique per step. This
      // handles every refresh/timing variant:
      //  - Pre-refresh only (completed step): persisted has everything, live is empty
      //  - Live-only (no bootstrap yet): persisted is empty, live drives
      //  - Mid-refresh (backend has written, frontend hasn't refetched): both
      //    have overlapping prefixes; merge preserves full ordering with no dupes
      const persistedSubsteps = Array.isArray(structured?.substeps)
        ? (structured!.substeps as Array<{ text?: unknown; at?: unknown }>)
            .filter((s) => typeof s.text === "string" && typeof s.at === "string")
            .map((s) => ({ text: s.text as string, at: s.at as string }))
        : []
      const substepsToShow = mergeSubstepsByText(persistedSubsteps, liveSubsteps ?? [])
      const isPartial = structured?.partial === true
      const partialReason = typeof structured?.partialReason === "string" ? structured.partialReason : null

      // Full completed result: content has memoCount etc. Render counts + badges + timeline.
      if (structured && "memoCount" in structured) {
        const memoCount = structured.memoCount as number
        const messageCount = structured.messageCount as number
        const attachmentCount = (structured.attachmentCount as number | undefined) ?? 0
        return (
          <div className="space-y-2.5">
            <div className="text-muted-foreground">
              Found {memoCount} {memoCount === 1 ? "memo" : "memos"}, {messageCount}{" "}
              {messageCount === 1 ? "message" : "messages"}, and {attachmentCount}{" "}
              {attachmentCount === 1 ? "attachment" : "attachments"}.
            </div>
            {isPartial && <PartialResultBadge stepType={stepType} reason={partialReason} />}
            {substepsToShow.length > 0 && (
              <SubstepTimeline substeps={substepsToShow} stepType={stepType} isLive={isInProgress} />
            )}
          </div>
        )
      }
      // In-flight / substep-only content: the observer has persisted a running
      // { substeps } JSON but tool:complete hasn't fired yet. Render just the
      // timeline. Fall back to the raw content string if nothing is available.
      if (substepsToShow.length > 0) {
        return <SubstepTimeline substeps={substepsToShow} stepType={stepType} isLive={isInProgress} />
      }
      return <span className="text-muted-foreground">{content}</span>
    }

    case "research": {
      // General research mirrors workspace_search's trace shape: a phase
      // timeline merged from persisted (step.content JSON) + live socket
      // substeps, an optional partial badge, and a completion summary. The
      // completed payload carries sourceCount + briefAdded rather than the
      // memo/message/attachment counts workspace_search reports.
      const persistedSubsteps = Array.isArray(structured?.substeps)
        ? (structured!.substeps as Array<{ text?: unknown; at?: unknown }>)
            .filter((s) => typeof s.text === "string" && typeof s.at === "string")
            .map((s) => ({ text: s.text as string, at: s.at as string }))
        : []
      const substepsToShow = mergeSubstepsByText(persistedSubsteps, liveSubsteps ?? [])
      const isPartial = structured?.partial === true
      const partialReason = typeof structured?.partialReason === "string" ? structured.partialReason : null

      if (structured && "sourceCount" in structured) {
        const sourceCount = structured.sourceCount as number
        const briefAdded = structured.briefAdded === true
        const brief = typeof structured.brief === "string" ? structured.brief.trim() : null
        return (
          <div className="space-y-2.5">
            <div className="text-muted-foreground">
              {briefAdded ? "Synthesised a brief from" : "Returned findings from"} {sourceCount}{" "}
              {sourceCount === 1 ? "source" : "sources"}.
            </div>
            {isPartial && <PartialResultBadge stepType={stepType} reason={partialReason} />}
            {brief && (
              <Collapsible>
                <CollapsibleTrigger className="group flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors">
                  <ChevronRight className="w-3 h-3 transition-transform group-data-[state=open]:rotate-90" />
                  Read the full brief
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-1.5">
                  <div className="rounded bg-muted/50 px-3 py-2 text-sm">
                    <MarkdownContent content={brief} className="text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0" />
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
            {substepsToShow.length > 0 && (
              <SubstepTimeline substeps={substepsToShow} stepType={stepType} isLive={isInProgress} />
            )}
          </div>
        )
      }
      if (substepsToShow.length > 0) {
        return <SubstepTimeline substeps={substepsToShow} stepType={stepType} isLive={isInProgress} />
      }
      return <span className="text-muted-foreground">{content}</span>
    }

    case "visit_page": {
      if (structured && "title" in structured) {
        return <span>{structured.title as string}</span>
      }
      if (structured && "url" in structured) {
        return <span className="text-muted-foreground">{structured.url as string}</span>
      }
      return <span>{content}</span>
    }

    case "message_sent": {
      const messagePreview = content.length > 100 ? content.slice(0, 100) + "..." : content
      return (
        <div className="group">
          <span className="text-muted-foreground">Sent message: </span>
          <span className="inline">
            "<MarkdownContent content={messagePreview} className="inline text-sm" />"
          </span>
          {messageLink && (
            <Link
              to={messageLink}
              className="inline-flex items-center gap-1 ml-2 text-xs text-muted-foreground hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity"
            >
              View message
              <ExternalLink className="w-3 h-3" />
            </Link>
          )}
        </div>
      )
    }

    case "message_edited": {
      const messagePreview = content.length > 100 ? content.slice(0, 100) + "..." : content
      return (
        <div className="group">
          <span className="text-muted-foreground">Updated previous message: </span>
          <span className="inline">
            "<MarkdownContent content={messagePreview} className="inline text-sm" />"
          </span>
          {messageLink && (
            <Link
              to={messageLink}
              className="inline-flex items-center gap-1 ml-2 text-xs text-muted-foreground hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity"
            >
              View message
              <ExternalLink className="w-3 h-3" />
            </Link>
          )}
        </div>
      )
    }

    case "tool_call": {
      if (structured && "tool" in structured) {
        const tool = structured.tool as string
        const query = structured.query as string | undefined
        const stream = structured.stream as string | undefined
        if (query) {
          return (
            <span>
              <strong>{tool}:</strong> "{query}"{stream && <span className="text-muted-foreground"> in {stream}</span>}
            </span>
          )
        }
        if (stream) {
          return (
            <span>
              <strong>{tool}:</strong> <span className="text-muted-foreground">{stream}</span>
            </span>
          )
        }
        return (
          <div className="space-y-1.5">
            <strong>{tool}</strong>
            {"args" in structured && (
              <pre className="rounded bg-muted/50 px-3 py-2 text-xs font-mono overflow-x-auto whitespace-pre">
                <code>{JSON.stringify(structured.args, null, 2)}</code>
              </pre>
            )}
          </div>
        )
      }
      if (isStructuredToolTrace(structured)) {
        return <ToolTraceContent headline={structured.headline} sections={structured.sections ?? []} isError={false} />
      }
      if (looksLikeStructuredToolTrace(content)) {
        return <TruncatedToolTraceContent content={content} isError={false} />
      }
      return <span>{content}</span>
    }

    case "turn_digest": {
      // The digest's JSON content (TurnDigestStepContent): model-written
      // findings prose plus the deterministic tool list. Its sources live
      // inside the JSON (already rendered on the originating tool steps), so
      // only the prose + tool list surface here.
      if (structured && typeof structured.findings === "string") {
        const toolsCalled = Array.isArray(structured.toolsCalled)
          ? (structured.toolsCalled as unknown[]).filter((t): t is string => typeof t === "string")
          : []
        return (
          <div className="space-y-2">
            <div className="text-muted-foreground text-[11px]">
              Saved a digest of this turn's tool work for future turns.
            </div>
            <MarkdownContent
              content={structured.findings as string}
              className="text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            />
            {toolsCalled.length > 0 && (
              <div className="text-[11px] text-muted-foreground">Tools used: {toolsCalled.join(", ")}</div>
            )}
          </div>
        )
      }
      return <span className="text-muted-foreground">Saved a digest of this turn's tool work for future turns.</span>
    }

    case "tool_error":
      if (isStructuredToolTrace(structured)) {
        return <ToolTraceContent headline={structured.headline} sections={structured.sections ?? []} isError={true} />
      }
      if (looksLikeStructuredToolTrace(content)) {
        return <TruncatedToolTraceContent content={content} isError={true} />
      }
      return <span>{content}</span>

    default:
      return <span>{content}</span>
  }
}

interface ToolSection {
  label: PiToolTraceSectionLabel
  body: string
  lang: string | null
}

interface StructuredToolTrace extends Record<string, unknown> {
  format: typeof PI_TOOL_TRACE_FORMAT
  headline?: string
  sections?: ToolSection[]
}

function isStructuredToolTrace(value: Record<string, unknown> | null): value is StructuredToolTrace {
  return value?.format === PI_TOOL_TRACE_FORMAT
}

function looksLikeStructuredToolTrace(content: string): boolean {
  return new RegExp(`"format"\\s*:\\s*"${PI_TOOL_TRACE_FORMAT}"`).test(content)
}

function TruncatedToolTraceContent({ content, isError }: { content: string; isError: boolean }) {
  return (
    <ToolTraceContent
      headline={isError ? "Tool error trace was truncated" : "Tool trace was truncated"}
      sections={[
        {
          label: PiToolTraceSectionLabels.DETAILS,
          body: content,
          lang: "json",
        },
      ]}
      isError={isError}
    />
  )
}

function ToolTraceContent({
  headline,
  sections,
  isError,
}: {
  headline?: string
  sections: ToolSection[]
  isError: boolean
}) {
  const headlineText = headline || (isError ? "Tool error" : "Tool call")

  return (
    <div className="space-y-2">
      <div className="font-mono text-[12.5px] leading-snug break-words text-foreground/90">{headlineText}</div>
      {sections.length > 0 && (
        <div className="space-y-1.5">
          {sections.map((section, i) => (
            <ToolSectionDisclosure
              key={`${section.label}-${i}`}
              section={section}
              defaultOpen={isError && section.label === PiToolTraceSectionLabels.ERROR_OUTPUT}
              isError={
                isError &&
                (section.label === PiToolTraceSectionLabels.ERROR_OUTPUT ||
                  section.label === PiToolTraceSectionLabels.DETAILS)
              }
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ToolSectionDisclosure({
  section,
  defaultOpen,
  isError,
}: {
  section: ToolSection
  defaultOpen: boolean
  isError: boolean
}) {
  const lineCount = section.body ? section.body.split("\n").length : 0
  const lineLabel = `${lineCount} ${lineCount === 1 ? "line" : "lines"}`

  return (
    <Collapsible defaultOpen={defaultOpen}>
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors">
        <ChevronRight className="w-3 h-3 transition-transform group-data-[state=open]:rotate-90" />
        <span>{section.label}</span>
        {lineCount > 0 && (
          <span className="ml-1 font-normal normal-case tracking-normal text-muted-foreground/70">{lineLabel}</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre
          className={cn(
            "mt-1.5 rounded-md px-3 py-2 text-[11px] font-mono leading-snug overflow-x-auto whitespace-pre max-h-[320px] overflow-y-auto",
            isError ? "bg-destructive/5 border border-destructive/20 text-foreground/90" : "bg-muted/60"
          )}
        >
          <code>{section.body || "(empty)"}</code>
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Format the elapsed time between two ISO timestamps in a compact form suitable
 * for inline timeline annotations (e.g. "+0.2s", "+1.4s", "+1m 12s"). Returns
 * null for sub-100ms deltas so fast paths don't produce noise like "+0.0s".
 */
function formatPhaseOffset(fromIso: string, toIso: string): string | null {
  const fromMs = Date.parse(fromIso)
  const toMs = Date.parse(toIso)
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null
  const deltaMs = toMs - fromMs
  if (deltaMs < 100) return null
  if (deltaMs < 60_000) return `+${(deltaMs / 1000).toFixed(1)}s`
  const totalSec = Math.round(deltaMs / 1000)
  const minutes = Math.floor(totalSec / 60)
  const seconds = totalSec % 60
  return `+${minutes}m ${seconds}s`
}

/**
 * Hue-aware phase timeline for a long-running tool's substep log.
 *
 * Design intent: every trace step wraps itself in a subtle hue-tinted container
 * driven by `STEP_DISPLAY_CONFIG` (workspace_search = purple, hue 270). The
 * SubstepTimeline pulls the same hue so it reads as part of the step's family,
 * not a foreign grey element grafted on.
 *
 * Visual vocabulary:
 * - Left-hand vertical rail in the step's hue at 25% opacity — anchors the
 *   phases as an ordered sequence.
 * - Hued dots at each phase: completed phases get a filled disc, the current
 *   in-flight phase (when `isLive`) gets a radar-style pulse ring.
 * - Relative timing offsets ("+0.2s", "+1.4s") on the right — turns the phase
 *   list into a crude performance profile, answering "where did the 4s go?".
 * - Staggered entry animation on first mount (tailwindcss-animate) so live
 *   substeps flow in rather than popping in at once.
 *
 * Substeps pulled from either the persisted step.content (refresh-stable for
 * completed steps) or the live socket stream (for in-flight steps). The caller
 * passes `isLive` so we can pulse only when the last phase is still running.
 */
function SubstepTimeline({
  substeps,
  stepType,
  isLive,
}: {
  substeps: Array<{ text: string; at: string }>
  stepType: AgentStepType
  isLive: boolean
}) {
  const config = STEP_DISPLAY_CONFIG[stepType]
  const hueColor = `hsl(${config.hue} ${config.saturation}% ${config.lightness}%)`
  const hueRail = `hsl(${config.hue} ${config.saturation}% ${config.lightness}% / 0.25)`
  const hueBg = `hsl(${config.hue} ${config.saturation}% ${config.lightness}% / 0.04)`
  const hueBorder = `hsl(${config.hue} ${config.saturation}% ${config.lightness}% / 0.18)`

  const firstAt = substeps[0]?.at

  return (
    <div
      className="rounded-item px-3 py-2.5"
      style={{
        background: hueBg,
        border: `1px solid ${hueBorder}`,
      }}
    >
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: hueColor }}>
        Phases
      </div>
      <ol className="relative space-y-1.5 pl-[18px]">
        {/* Vertical rail anchored to the dot centerline (9px dot column + 9px dot center = 9px from left of padding) */}
        <span
          aria-hidden
          className="absolute left-[4px] top-[5px] bottom-[5px] w-px rounded-full"
          style={{ background: hueRail }}
        />
        {substeps.map((substep, i) => {
          const isLast = i === substeps.length - 1
          const showPulse = isLast && isLive
          const offset = firstAt && !isLast ? formatPhaseOffset(firstAt, substep.at) : null
          return (
            <li
              key={`${substep.at}-${i}`}
              className="relative flex items-start gap-2 text-[12px] leading-tight animate-in fade-in-0 slide-in-from-left-1 fill-mode-both"
              style={{
                animationDelay: `${Math.min(i, 8) * 40}ms`,
                animationDuration: "260ms",
              }}
            >
              {/* Phase dot sitting on the rail */}
              <span
                aria-hidden
                className="absolute -left-[18px] top-[5px] inline-flex h-[9px] w-[9px] items-center justify-center"
              >
                {showPulse && (
                  <span
                    className="absolute inset-0 rounded-full animate-activity-pulse"
                    style={{ background: hueColor, opacity: 0.35 }}
                  />
                )}
                <span
                  className="relative h-[7px] w-[7px] rounded-full"
                  style={{
                    background: isLast
                      ? hueColor
                      : `hsl(${config.hue} ${config.saturation}% ${config.lightness}% / 0.7)`,
                    boxShadow: isLast
                      ? `0 0 0 2px hsl(${config.hue} ${config.saturation}% ${config.lightness}% / 0.15)`
                      : undefined,
                  }}
                />
              </span>
              <span className={cn("flex-1 min-w-0 break-words text-foreground/90", isLast && isLive && "font-medium")}>
                {substep.text}
              </span>
              {offset && (
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">{offset}</span>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/**
 * Context-aware partial-result badge.
 *
 * `user_abort` uses the step's own hue (gentle "you intentionally stopped this").
 * `timeout` uses amber (warning "we ran out of budget"). An icon reinforces the
 * cause so a scanning eye gets the meaning without reading the text.
 */
function PartialResultBadge({ stepType, reason }: { stepType: AgentStepType; reason: string | null }) {
  const config = STEP_DISPLAY_CONFIG[stepType]
  const isAbort = reason === "user_abort"

  const accentColor = isAbort ? `hsl(${config.hue} ${config.saturation}% ${config.lightness}%)` : "hsl(32 95% 44%)"
  const bgColor = isAbort
    ? `hsl(${config.hue} ${config.saturation}% ${config.lightness}% / 0.06)`
    : "hsl(32 95% 44% / 0.06)"
  const borderColor = isAbort
    ? `hsl(${config.hue} ${config.saturation}% ${config.lightness}% / 0.25)`
    : "hsl(32 95% 44% / 0.3)"
  const Icon = isAbort ? CircleSlash : Clock
  const label = isAbort ? "Stopped on user request" : "Deadline reached"
  const description = isAbort
    ? "Returned the context found so far."
    : "Research hit the wall-clock budget and returned partial context."

  return (
    <div
      className="flex items-start gap-2 rounded-item px-2.5 py-1.5"
      style={{ background: bgColor, border: `1px solid ${borderColor}` }}
    >
      <Icon className="mt-[1px] h-3.5 w-3.5 shrink-0" style={{ color: accentColor }} />
      <div className="min-w-0 text-[11px] leading-snug">
        <span className="font-medium" style={{ color: accentColor }}>
          {label}
        </span>
        <span className="text-muted-foreground"> — {description}</span>
      </div>
    </div>
  )
}

/**
 * Merge two substep lists by `text` (which is unique per step).
 *
 * Order is preserved: `base` first (persisted history from the bootstrap fetch),
 * then `incoming` entries that aren't already present (live socket updates that
 * arrived after the fetch). This gives the trace dialog a complete, stable view
 * whether the step was loaded from the DB, streamed live, or a mix of both
 * (the common mid-refresh case).
 */
function mergeSubstepsByText(
  base: Array<{ text: string; at: string }>,
  incoming: Array<{ text: string; at: string }>
): Array<{ text: string; at: string }> {
  if (incoming.length === 0) return base
  if (base.length === 0) return incoming
  const seen = new Set<string>()
  const merged: Array<{ text: string; at: string }> = []
  for (const substep of base) {
    if (seen.has(substep.text)) continue
    seen.add(substep.text)
    merged.push(substep)
  }
  for (const substep of incoming) {
    if (seen.has(substep.text)) continue
    seen.add(substep.text)
    merged.push(substep)
  }
  return merged
}

function RerunContextSummary({ rerunContext }: { rerunContext: RerunContextInfo }) {
  const causeLabel =
    rerunContext.cause === "invoking_message_edited"
      ? "Rerun caused by invoking message edit"
      : "Rerun caused by follow-up message edit"

  const before = rerunContext.editedMessageBefore?.trim()
  const after = rerunContext.editedMessageAfter?.trim()
  let editSummary: React.ReactNode = null
  if (before && after && before !== after) {
    editSummary = (
      <div className="text-xs">
        <span className="font-medium">Edit:</span> "{before}" → "{after}"
      </div>
    )
  } else if (after) {
    editSummary = (
      <div className="text-xs">
        <span className="font-medium">Edited message:</span> "{after}"
      </div>
    )
  }

  return (
    <div className="rounded bg-muted/40 px-3 py-2 space-y-1">
      <div className="text-[11px] font-medium text-muted-foreground">{causeLabel}</div>
      {editSummary}
    </div>
  )
}

interface SourceListProps {
  sources: TraceSource[]
  config: { hue: number; saturation: number; lightness: number }
  workspaceId: string
}

function SourceList({ sources, config, workspaceId }: SourceListProps) {
  return (
    <Collapsible className="mt-4">
      <CollapsibleTrigger className="flex items-center justify-between w-full py-2 text-left group">
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <FileText className="w-4 h-4" />
          Sources
          <span className="bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full text-[11px] font-semibold">
            {sources.length}
          </span>
        </div>
        <ChevronRight className="w-4 h-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div
          className="mt-2 rounded-md text-xs"
          style={{
            background: "hsl(var(--muted) / 0.3)",
            borderLeft: `3px solid hsl(${config.hue} ${config.saturation}% ${config.lightness}%)`,
          }}
        >
          {sources.map((source, i) => (
            <SourceItem key={i} source={source} workspaceId={workspaceId} isLast={i === sources.length - 1} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function SourceItem({ source, workspaceId, isLast }: { source: TraceSource; workspaceId: string; isLast: boolean }) {
  const internalLink = buildSourceLink(source, workspaceId)

  return (
    <div className={cn("px-2.5 py-1.5 mx-[-1px]", !isLast && "border-b border-border")}>
      <div className="font-semibold mb-1 text-xs break-words">
        <SourceTitle source={source} internalLink={internalLink} />
      </div>
      {source.domain && <div className="text-[11px] text-muted-foreground mb-1 break-words">{source.domain}</div>}
      {source.authorName && source.type === "workspace_message" && (
        <div className="text-[11px] text-muted-foreground mb-1">
          by {source.authorName}
          {source.streamName && ` in ${source.streamName}`}
        </div>
      )}
      {source.streamName && source.type === "workspace_memo" && (
        <div className="text-[11px] text-muted-foreground mb-1">from {source.streamName}</div>
      )}
      {source.snippet && (
        <div className="text-muted-foreground text-[11px] leading-snug line-clamp-2">{source.snippet}</div>
      )}
    </div>
  )
}

function buildSourceLink(source: TraceSource, workspaceId: string): string | null {
  if (source.type === "workspace_memo" && source.memoId) {
    return `/w/${workspaceId}/memory?memo=${source.memoId}`
  }
  if (source.type === "workspace_message" && source.streamId && source.messageId) {
    return `/w/${workspaceId}/s/${source.streamId}?m=${source.messageId}`
  }
  if (source.url?.startsWith("/w/")) {
    return source.url
  }
  return null
}

function SourceTitle({ source, internalLink }: { source: TraceSource; internalLink: string | null }) {
  if (internalLink) {
    return (
      <Link to={internalLink} className="text-primary hover:underline">
        {source.title}
      </Link>
    )
  }
  if (source.url) {
    return (
      <a href={source.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
        {source.title}
      </a>
    )
  }
  return <>{source.title}</>
}

/** Preview of a message in context_received or reconsidering steps */
function MessagePreview({ message, highlight }: { message: MessageInfo; highlight?: boolean }) {
  const isPersona = message.authorType === "persona"
  const messageChangeLabel = getMessageChangeLabel(message.changeType)
  // Truncate long content but preserve markdown structure
  const preview = message.content.length > 150 ? message.content.slice(0, 150) + "..." : message.content

  return (
    <div
      className={cn("rounded px-3 py-2 text-xs", highlight ? "bg-primary/10 border border-primary/20" : "bg-muted/50")}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className={cn("font-medium", isPersona && "text-primary")}>{message.authorName}</span>
        {messageChangeLabel && (
          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {messageChangeLabel}
          </span>
        )}
        <span className="text-muted-foreground text-[10px]">
          <RelativeTime date={message.createdAt} className="text-[10px] text-muted-foreground" />
        </span>
      </div>
      <MarkdownContent content={preview} className="text-xs leading-relaxed text-foreground/90" />
    </div>
  )
}

function getMessageChangeLabel(changeType: MessageInfo["changeType"]): string | null {
  switch (changeType) {
    case "message_created":
      return "New"
    case "message_edited":
      return "Edited"
    case "message_deleted":
      return "Deleted"
    default:
      return null
  }
}

/**
 * Renders the resolved context-bag attached to the agent's turn: one chip
 * per ref (matching the in-stream `MessageContextBadge` so the trace and
 * the timeline tell the same story) with a collapsible list of the actual
 * referenced messages tucked underneath.
 *
 * The chip label is generated by `formatContextRefLabel` — the same helper
 * the timeline pill uses — so labels stay byte-identical across surfaces.
 * The inline expansion exists because the trace's job is to surface MORE
 * than the stream view shows: users need to see what messages were fed to
 * the model, not just that something was attached.
 */
function AttachedContextSection({
  attachedContext,
  workspaceId,
}: {
  attachedContext: AttachedContextInfo
  workspaceId: string
}) {
  return (
    <div>
      <div className="text-muted-foreground text-[11px] mb-1.5 font-medium">Attached context:</div>
      <div className="space-y-2">
        {attachedContext.refs.map((contextRef) => (
          <AttachedContextRef
            key={`${contextRef.streamId}|${contextRef.fromMessageId ?? ""}|${contextRef.toMessageId ?? ""}`}
            contextRef={contextRef}
            workspaceId={workspaceId}
          />
        ))}
      </div>
    </div>
  )
}

function AttachedContextRef({ contextRef, workspaceId }: { contextRef: AttachedContextRefInfo; workspaceId: string }) {
  const label = formatContextRefLabel({
    slug: contextRef.source.slug,
    displayName: contextRef.source.displayName,
    streamType: contextRef.source.type,
    itemCount: contextRef.source.itemCount,
    fromMessageId: contextRef.fromMessageId,
    toMessageId: contextRef.toMessageId,
  })
  const href = buildContextRefSourceHref({
    workspaceId,
    sourceStreamId: contextRef.streamId,
    originMessageId: contextRef.originMessageId,
  })
  const messageCount = contextRef.messages.length

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-2">
        <AttachmentPill
          icon={MessageSquareReply}
          label={label}
          labelMaxWidth="max-w-[260px]"
          href={href}
          tooltip="Click to open the source thread"
        />
      </div>
      {messageCount > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors">
            <ChevronRight className="w-3 h-3 transition-transform group-data-[state=open]:rotate-90" />
            Show {messageCount} {messageCount === 1 ? "message" : "messages"} fed to the model
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-1.5">
            <div className="space-y-1.5">
              {contextRef.messages.map((m) => (
                <AttachedContextMessage key={m.messageId} message={m} />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}

function AttachedContextMessage({ message }: { message: AttachedContextRefInfo["messages"][number] }) {
  // INV-60: preview surfaces strip markdown to inline plain text so literal
  // syntax (`**bold**`, fenced code) doesn't leak as characters and so a
  // 150-char hard cut can't slice through markup mid-token.
  const stripped = stripMarkdownToInline(message.content)
  const preview = stripped.length > 150 ? stripped.slice(0, 150) + "…" : stripped
  return (
    <div className="rounded px-3 py-2 text-xs bg-muted/50">
      <div className="flex items-center gap-2 mb-1">
        <span className="font-medium">{message.authorName}</span>
        <span className="text-muted-foreground text-[10px]">
          <RelativeTime date={message.createdAt} className="text-[10px] text-muted-foreground" />
        </span>
      </div>
      <p className="text-xs leading-relaxed text-foreground/90">{preview}</p>
    </div>
  )
}
