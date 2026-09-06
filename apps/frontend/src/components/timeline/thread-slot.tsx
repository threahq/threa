import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import type { ThreadSummary } from "@threahq/types"
import { getStepLabel, type MessageAgentActivity, type ScopeDraftPreview } from "@/hooks"
import { useTrace } from "@/contexts"
import { cn } from "@/lib/utils"
import { ThreadCard } from "./thread-card"

interface ThreadSlotProps {
  activity?: MessageAgentActivity
  replyCount: number
  threadHref: string | null
  summary?: ThreadSummary
  workspaceId: string
  /** The viewer's unsent reply draft for this anchor (`useThreadDraft`). */
  draft?: ScopeDraftPreview | null
  /** Panel url for the not-yet-created thread (`useThreadAnchor().replyUrl`) —
   *  where a draft-only card points until a real thread exists. */
  draftHref?: string | null
}

/**
 * Single-slot footer element that unifies the "Ariadne is thinking…" indicator
 * and the ThreadCard. The gold 2px left-line is owned by the slot (not the
 * card) so it:
 *
 *   1. persists across pill → card transitions without unmounting (no null
 *      frame, no flicker between the two states)
 *   2. grows in from top-to-bottom via `animate-thread-grow` the first time
 *      the slot becomes visible during this component's lifetime (not on
 *      every Virtuoso remount — ref-gated)
 *   3. extends smoothly when the thinking row expands into the card via a
 *      `grid-template-rows` transition — the line is absolute-positioned to
 *      the slot container, so it follows the container's growing height
 *
 * When nothing is thread-related (no activity, no replies, no draft), the slot
 * returns null. Otherwise the line is always present; the body swaps between a
 * "thinking" line (italic text + persona) and the full ThreadCard body.
 *
 * A viewer's unsent draft reply keeps the slot visible before the thread stream
 * exists, and the card it renders occupies the SAME grid cell as the reply card
 * — so sending the draft is a content swap inside a mounted slot: the gold line
 * persists and `visible` never flips, which is what stops the grow-in animation
 * from replaying on the send.
 */
export function ThreadSlot({
  activity,
  replyCount,
  threadHref,
  summary,
  workspaceId,
  draft,
  draftHref,
}: ThreadSlotProps) {
  const hasActivity = !!activity
  const hasThread = replyCount > 0 && !!threadHref
  const cardHref = threadHref ?? draftHref ?? null
  const hasDraft = !!draft && !!cardHref
  const showCard = hasThread || hasDraft
  const visible = hasActivity || showCard

  // Only play the grow-in animation for genuine post-mount transitions —
  // e.g. Ariadne starts thinking mid-session, or a reply lands while the
  // stream is already in view. Two guards:
  //
  //   1. `wasVisibleRef` captures `visible` at mount so Virtuoso remounts
  //      of an already-visible slot don't replay it.
  //   2. `hasSettledRef` adds a 300ms grace after mount during which any
  //      visible-flip is treated as initial hydration, not a real state
  //      change. Without this, stream switches show every threaded message
  //      animating in — IDB events hydrate a frame after mount, flipping
  //      `visible` from false → true, and the grow-in reads as "messages
  //      with threads load later".
  const wasVisibleRef = useRef(visible)
  const hasSettledRef = useRef(false)
  const [animate, setAnimate] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      hasSettledRef.current = true
    }, 300)
    return () => window.clearTimeout(timer)
  }, [])
  useEffect(() => {
    const wasVisible = wasVisibleRef.current
    wasVisibleRef.current = visible
    if (visible && !wasVisible && hasSettledRef.current) {
      setAnimate(true)
      const timer = window.setTimeout(() => setAnimate(false), 550)
      return () => window.clearTimeout(timer)
    }
  }, [visible])

  if (!visible) return null

  return (
    <div className="relative mt-2">
      {/* Persistent gold thread-line. Spans the slot via `inset-y-0`, so when
          the grid row below expands from thinking → card, the line grows with
          it. `origin-top` + `animate-thread-grow` makes it sprout downward on
          first appearance. `scaleY(1)` is the natural default after the
          animation, so removing the class does not snap the line back. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute left-0 top-[-4px] bottom-[-2px] w-[2px] overflow-hidden rounded-full",
          "origin-top bg-primary/70 transition-colors",
          animate && "animate-thread-grow"
        )}
      >
        {hasActivity && (
          <span
            aria-hidden
            className="absolute inset-x-0 top-0 h-5 animate-thread-weave bg-gradient-to-b from-transparent via-primary/90 to-transparent opacity-90"
          />
        )}
      </span>

      {/* Grid with two rows — thinking (1fr when pill-only, 0fr when card)
          and card (1fr when card, 0fr when pill-only). `grid-template-rows`
          animates in modern browsers (Chrome 111+, Firefox 120+, Safari 17+),
          smoothly extending the slot height on pill → card. Older browsers
          snap to the final rows without transition. */}
      <div
        className="grid transition-[grid-template-rows] duration-[450ms] ease-out"
        style={{
          gridTemplateRows: showCard ? "0fr 1fr" : "1fr 0fr",
        }}
      >
        <div className="overflow-hidden">{activity && !showCard ? <ThinkingRow activity={activity} /> : null}</div>
        <div className="overflow-hidden">
          {showCard && cardHref ? (
            <ThreadCard
              replyCount={hasThread ? replyCount : 0}
              href={cardHref}
              workspaceId={workspaceId}
              summary={summary}
              draft={draft}
              isActive={hasActivity}
              ownsLeftLine={false}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}

function withTrailingEllipsis(text: string): string {
  return text.replace(/[.…\s]+$/u, "") + "…"
}

/**
 * Inline "thinking" row rendered in the thinking grid cell. No container chrome
 * (no line, no background) — the slot's left-line and the row's own indent are
 * all the visual structure it needs. Clicking opens the trace.
 */
function ThinkingRow({ activity }: { activity: MessageAgentActivity }) {
  const { getTraceUrl } = useTrace()
  const label = activity.substep
    ? withTrailingEllipsis(activity.substep)
    : `is ${withTrailingEllipsis(getStepLabel(activity.currentStepType).toLowerCase())}`

  return (
    <Link
      to={getTraceUrl(activity.sessionId)}
      className={cn(
        "group/thinking flex items-center py-1 pl-3 pr-2 text-xs italic",
        "text-primary/75 hover:text-primary transition-colors"
      )}
      aria-label={`${activity.personaName} ${label}`}
    >
      <span className="truncate max-w-[280px]">
        <span className="not-italic font-medium text-primary/95">{activity.personaName}</span>{" "}
        <span className="text-primary/65 group-hover/thinking:text-primary/90">{label}</span>
      </span>
    </Link>
  )
}
