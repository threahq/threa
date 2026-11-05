import { useId } from "react"
import { Link } from "react-router-dom"
import { ChevronRight } from "lucide-react"
import { useTrace } from "@/contexts"
import { RelativeTime } from "@/components/relative-time"
import { formatDuration } from "@/lib/dates"
import { cn } from "@/lib/utils"
import { composeBlockCollapseKey } from "@/lib/markdown/markdown-block-context"
import { getBlockCollapse, setBlockCollapse, useBlockCollapseVersion } from "@/lib/markdown/collapse-cache"
import type { TimelineItem } from "./event-list"
import { SessionEffectGrid } from "./session-effect-grid"
import {
  buildSessionStatusConfig,
  deriveSessionStatus,
  formatCount,
  sessionEffectsFor,
  sessionTotals,
} from "./agent-session-status"

type RunGroupSessions = Extract<TimelineItem, { type: "agent_run_group" }>["sessions"]

interface AgentRunGroupEventProps {
  sessions: RunGroupSessions
  unreadCount: number
}

function describeMember(events: RunGroupSessions[number]["events"]) {
  const derived = deriveSessionStatus(events)
  const { described, markerCount } = sessionEffectsFor(derived)
  const config = buildSessionStatusConfig(derived, { markerEffectCount: markerCount })
  return { derived, described, markerCount, config, totals: sessionTotals(derived) }
}

export function AgentRunGroupEvent({ sessions, unreadCount }: AgentRunGroupEventProps) {
  const { getTraceUrl } = useTrace()
  const regionId = useId()
  // Saved per member, not per head: an earlier run ending, or an older page
  // loading, puts a new session at the head, and the viewer's choice must survive.
  useBlockCollapseVersion()
  const collapseKeys = sessions.map((s) => composeBlockCollapseKey(s.sessionId, "agent-runs", "head"))
  const collapsed = !collapseKeys.some((key) => getBlockCollapse(key) === false)
  const toggle = () =>
    sessions.forEach((s, i) => setBlockCollapse(collapseKeys[i]!, s.sessionId, "agent-runs", !collapsed))

  const members = sessions.map((session) => ({ session, ...describeMember(session.events) }))
  const failed = members.filter((m) => m.derived.status === "failed")
  // Frame and icon follow the worst member, so a group reads like the card it replaces.
  const lead = failed[0] ?? members.find((m) => m.derived.status === "completed") ?? members[0]

  let steps = 0
  let duration = 0
  let messages = 0
  let changes = 0
  for (const { totals, described, markerCount } of members) {
    steps += totals.steps
    duration += totals.durationMs ?? 0
    messages += totals.messages
    changes += described.length + markerCount
  }
  const subtitle = [formatCount(steps, "step"), formatDuration(duration), `${formatCount(messages, "message")} sent`]
  if (changes > 0) subtitle.push(formatCount(changes, "change"))

  const title =
    failed.length > 0 ? `${sessions.length} sessions · ${failed.length} failed` : `${sessions.length} sessions complete`
  const personaNames = new Set(members.map((m) => m.derived.startedPayload?.personaName))
  const showPersona = personaNames.size > 1
  const timestamp = members[members.length - 1].config.timestamp

  return (
    <div className="py-3">
      <div
        className="overflow-hidden rounded-[10px] text-[13px]"
        style={{ background: lead.config.bgColor, border: `1px solid ${lead.config.borderColor}` }}
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={collapsed ? undefined : regionId}
          className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-all duration-150"
          onClick={toggle}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = lead.config.hoverBgColor
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = ""
          }}
        >
          {lead.config.icon}
          <div className="min-w-0 flex-1">
            <div
              className="min-w-0 truncate font-medium"
              style={failed.length > 0 ? { color: lead.config.titleColor } : undefined}
            >
              {title}
            </div>
            <div className="mt-0.5 min-w-0 truncate text-[11px] text-muted-foreground">{subtitle.join(" • ")}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-[11px]">
            {unreadCount > 0 && (
              <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                {unreadCount} new
              </span>
            )}
            {timestamp && <RelativeTime date={timestamp} className="text-muted-foreground" />}
            <ChevronRight
              aria-hidden
              className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", !collapsed && "rotate-90")}
            />
          </div>
        </button>
        {!collapsed && (
          <div id={regionId} className="border-t py-1" style={{ borderColor: lead.config.borderColor }}>
            {members.map(({ session, derived, described, config }) => (
              <div key={session.sessionId}>
                <Link
                  to={getTraceUrl(session.sessionId)}
                  className="flex min-h-11 items-center gap-3 px-3.5 py-1.5 text-[12px] no-underline hover:bg-foreground/5 sm:min-h-0"
                >
                  {config.icon}
                  {showPersona && (
                    <span className="shrink-0 font-medium text-foreground">{derived.startedPayload?.personaName}</span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{config.subtitle}</span>
                  {config.timestamp && (
                    <RelativeTime date={config.timestamp} className="shrink-0 text-[11px] text-muted-foreground" />
                  )}
                </Link>
                <SessionEffectGrid effects={described} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
