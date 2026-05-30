import { useCallback, useMemo } from "react"
import { useNavigate, useParams } from "react-router-dom"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogClose,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { RelativeTime } from "@/components/relative-time"
import { useTrace, useSocket } from "@/contexts"
import { useAbortResearch } from "@/hooks"
import { useAgentTrace } from "@/hooks/use-agent-trace"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { TraceStepList } from "./trace-step-list"
import { X } from "lucide-react"
import { formatDuration } from "@/lib/dates"
import type { AgentSession, AgentSessionRerunContext, AgentSessionStatus } from "@threa/types"

const STATUS_TEXT: Record<AgentSessionStatus, string> = {
  pending: "Session pending",
  running: "Session running",
  completed: "Session completed",
  failed: "Session failed",
  deleted: "Session deleted",
  superseded: "Session superseded",
}

export function TraceDialog() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const navigate = useNavigate()
  const { sessionId, highlightMessageId, getTraceUrl, closeTraceModal } = useTrace()
  const socket = useSocket()
  const abortResearch = useAbortResearch(socket)
  // Resolved once and threaded into the step list so each step can decrypt
  // sealed (enclave) content via the viewer's E2E session.
  const userId = useWorkspaceUserId(workspaceId!)

  const { steps, streamingSubsteps, session, relatedSessions, persona, status, isLoading, error } = useAgentTrace(
    workspaceId!,
    sessionId!
  )

  // Bind workspace + session once here so the in-flight step card can invoke it
  // without needing either identifier in its own scope. Only wired when the
  // session is actively running — abort on a completed session is a no-op at
  // the server so it's cheap, but there's no reason to show the button then.
  const handleAbortResearch = useCallback(() => {
    if (!sessionId || !workspaceId) return
    abortResearch({ sessionId, workspaceId })
  }, [abortResearch, sessionId, workspaceId])

  if (!sessionId) return null

  let lineageSessions: AgentSession[] = []
  if (relatedSessions.length > 0) {
    lineageSessions = relatedSessions
  } else if (session) {
    lineageSessions = [session]
  }

  const sessionOptions = useMemo(() => buildSessionOptions(lineageSessions), [lineageSessions])
  const versionById = useMemo(() => buildVersionBySessionId(lineageSessions), [lineageSessions])
  const supersededByVersion = useMemo(() => {
    if (!session || session.status !== "superseded") return null

    const successor = [...lineageSessions]
      .filter((candidate) => candidate.supersedesSessionId === session.id)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]
    if (!successor) return null

    const successorVersion = versionById.get(successor.id)
    return successorVersion ? `Version ${successorVersion}` : null
  }, [session, lineageSessions, versionById])

  const sessionDuration = session?.completedAt
    ? formatDuration(new Date(session.completedAt).getTime() - new Date(session.createdAt).getTime())
    : null
  const rerunReasonLabel = formatRerunReasonLabel(session?.rerunContext)
  const rerunReasonDetail = formatRerunReasonDetail(session?.rerunContext)

  const messageCount = steps.filter((s) => s.stepType === "message_sent" || s.stepType === "message_edited").length

  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && closeTraceModal()}>
      <ResponsiveDialogContent
        desktopClassName="max-w-3xl max-h-[85vh] sm:flex flex-col p-0 gap-0 [&>button:last-child]:hidden"
        drawerClassName="flex flex-col p-0"
        hideCloseButton
      >
        <TraceHeader
          isLoading={isLoading}
          personaName={persona?.name}
          sessionCreatedAt={session?.createdAt}
          sessionDuration={sessionDuration}
          rerunReasonLabel={rerunReasonLabel}
          rerunReasonDetail={rerunReasonDetail}
          supersededByVersion={supersededByVersion}
          selectedSessionId={sessionId}
          sessionOptions={sessionOptions}
          onSessionChange={(nextSessionId) => {
            if (nextSessionId === sessionId) return
            navigate(getTraceUrl(nextSessionId, highlightMessageId ?? undefined), { replace: true })
          }}
        />

        <TraceBody
          isLoading={isLoading}
          error={error}
          steps={steps}
          streamingSubsteps={streamingSubsteps}
          highlightMessageId={highlightMessageId}
          workspaceId={workspaceId!}
          streamId={session?.streamId ?? ""}
          userId={userId}
          onAbortResearch={status === "running" ? handleAbortResearch : undefined}
        />

        {status && <TraceFooter status={status} stepCount={steps.length} messageCount={messageCount} />}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function TraceHeader({
  isLoading,
  personaName,
  sessionCreatedAt,
  sessionDuration,
  rerunReasonLabel,
  rerunReasonDetail,
  supersededByVersion,
  selectedSessionId,
  sessionOptions,
  onSessionChange,
}: {
  isLoading: boolean
  personaName?: string
  sessionCreatedAt?: string
  sessionDuration: string | null
  rerunReasonLabel: string | null
  rerunReasonDetail: string | null
  supersededByVersion: string | null
  selectedSessionId: string
  sessionOptions: SessionOption[]
  onSessionChange: (sessionId: string) => void
}) {
  return (
    <div className="px-4 sm:px-6 py-4 border-b shrink-0 flex items-center justify-between gap-2">
      <div className="min-w-0 flex-1">
        <ResponsiveDialogTitle className="text-lg font-semibold truncate">
          {isLoading ? <Skeleton className="h-5 w-48" /> : "Agent Session Trace"}
        </ResponsiveDialogTitle>
        {personaName && sessionCreatedAt && (
          <div className="mt-1 space-y-1">
            <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
              <span>{personaName}</span>
              <span className="max-sm:hidden">•</span>
              <RelativeTime date={sessionCreatedAt} className="text-xs text-muted-foreground" />
              {sessionDuration && (
                <>
                  <span className="max-sm:hidden">•</span>
                  <span>{sessionDuration}</span>
                </>
              )}
              {rerunReasonLabel && (
                <>
                  <span className="max-sm:hidden">•</span>
                  <span className="max-sm:hidden">{rerunReasonLabel}</span>
                </>
              )}
              {supersededByVersion && (
                <>
                  <span className="max-sm:hidden">•</span>
                  <span className="max-sm:hidden">Superseded by {supersededByVersion}</span>
                </>
              )}
            </div>
            {rerunReasonDetail && (
              <div className="text-[11px] text-muted-foreground max-sm:hidden">{rerunReasonDetail}</div>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {!isLoading && sessionOptions.length > 1 && (
          <Select value={selectedSessionId} onValueChange={onSessionChange}>
            <SelectTrigger className="h-8 w-auto sm:w-[220px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {sessionOptions.map((option) => (
                <SelectItem key={option.id} value={option.id} className="text-xs">
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <ResponsiveDialogClose className="w-8 h-8 rounded-md flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
          <X className="w-5 h-5" />
          <span className="sr-only">Close</span>
        </ResponsiveDialogClose>
      </div>
    </div>
  )
}

function formatRerunReasonDetail(rerunContext?: AgentSessionRerunContext | null): string | null {
  if (!rerunContext) return null

  const before = shortenRerunPreview(rerunContext.editedMessageBefore)
  const after = shortenRerunPreview(rerunContext.editedMessageAfter)

  if (before && after && before !== after) {
    return `Edited message changed from "${before}" to "${after}"`
  }
  if (after) {
    return `Edited message now says "${after}"`
  }
  return null
}

function shortenRerunPreview(content?: string | null): string | null {
  const trimmed = content?.trim()
  if (!trimmed) return null
  if (trimmed.length <= 120) return trimmed
  return `${trimmed.slice(0, 117)}...`
}

function formatRerunReasonLabel(rerunContext?: AgentSessionRerunContext | null): string | null {
  if (!rerunContext) return null
  switch (rerunContext.cause) {
    case "invoking_message_edited":
      return "Rerun triggered by invoking message edit"
    case "referenced_message_edited":
      return "Rerun triggered by follow-up message edit"
    default:
      return null
  }
}

function TraceBody({
  isLoading,
  error,
  steps,
  streamingSubsteps,
  highlightMessageId,
  workspaceId,
  streamId,
  userId,
  onAbortResearch,
}: {
  isLoading: boolean
  error: Error | null
  steps: ReturnType<typeof useAgentTrace>["steps"]
  streamingSubsteps: ReturnType<typeof useAgentTrace>["streamingSubsteps"]
  highlightMessageId: string | null
  workspaceId: string
  streamId: string
  userId: string | null
  onAbortResearch?: () => void
}) {
  let content = (
    <TraceStepList
      steps={steps}
      highlightMessageId={highlightMessageId}
      workspaceId={workspaceId}
      streamId={streamId}
      userId={userId}
      streamingSubsteps={streamingSubsteps}
      onAbortResearch={onAbortResearch}
    />
  )
  if (isLoading) {
    content = (
      <div className="p-6 space-y-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    )
  } else if (error) {
    content = <div className="p-6 text-center text-destructive">Failed to load trace. Please try again.</div>
  }

  return <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden">{content}</div>
}

function TraceFooter({
  status,
  stepCount,
  messageCount,
}: {
  status: AgentSessionStatus
  stepCount: number
  messageCount: number
}) {
  return (
    <div className="px-4 sm:px-6 py-4 border-t shrink-0 flex items-center justify-between text-xs text-muted-foreground">
      <span>{STATUS_TEXT[status]}</span>
      <span>
        {stepCount} {stepCount === 1 ? "step" : "steps"} • {messageCount} {messageCount === 1 ? "message" : "messages"}{" "}
        sent
      </span>
    </div>
  )
}

interface SessionOption {
  id: string
  label: string
}

function buildVersionBySessionId(sessions: AgentSession[]): Map<string, number> {
  const ascending = [...sessions].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  return new Map(ascending.map((session, index) => [session.id, index + 1]))
}

function buildSessionOptions(sessions: AgentSession[]): SessionOption[] {
  if (sessions.length === 0) return []

  const versionById = buildVersionBySessionId(sessions)

  const newestFirst = [...sessions].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  return newestFirst.map((session) => {
    const version = versionById.get(session.id) ?? 1
    const status = STATUS_TEXT[session.status].replace(/^Session\s+/, "")
    return {
      id: session.id,
      label: version > 1 ? `Version ${version} • ${status}` : status,
    }
  })
}
