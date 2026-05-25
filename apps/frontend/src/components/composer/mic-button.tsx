import { useEffect, useRef } from "react"
import { Mic, Loader2, AlertTriangle, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useVoiceDictation, type VoiceDictationState } from "@/hooks/use-voice-dictation"
import { DictationChunkInspector } from "./dictation-chunk-inspector"

// Surface the cap warning in the final stretch so the auto-stop isn't a surprise.
const NEAR_CAP_MS = 60_000

// Voice-reactive halo for the recording state: a crisp inner ring gives the live
// state a defined edge, and a single soft ring breathes outward as the input
// level rises so the button responds to the speaker's voice without bleeding
// into neighboring controls. Built purely from layered box-shadows so it never
// reflows neighbors (INV-21) and reads the same at both the 28px inline and 30px
// FAB sizes the button renders at.
export function recordingRingShadow(level: number): string {
  const l = Math.max(0, Math.min(1, level))
  return [
    `0 0 0 ${(1 + l * 1).toFixed(2)}px hsl(var(--destructive) / ${(0.3 + l * 0.25).toFixed(3)})`,
    `0 0 0 ${(2.5 + l * 4).toFixed(2)}px hsl(var(--destructive) / ${(0.08 + l * 0.1).toFixed(3)})`,
  ].join(", ")
}

export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

function actionLabelFor(state: VoiceDictationState): string {
  if (state === "recording") return "Stop dictation"
  if (state === "error") return "Retry dictation"
  return "Dictate a message"
}

function tooltipFor(args: {
  supported: boolean
  unsupportedReason: string | null
  state: VoiceDictationState
  error: string | null
}): string {
  if (!args.supported) return args.unsupportedReason ?? "Voice input isn't available"
  if (args.state === "recording") return "Stop dictation"
  if (args.state === "connecting") return "Starting…"
  if (args.state === "error") return args.error ?? "Dictation failed — tap to retry"
  return "Dictate a message"
}

interface MicButtonProps {
  workspaceId: string
  /** Insert a committed transcript span into the editor at the caret. */
  onInsertText: (text: string) => void
  /** Live (uncommitted) transcript hypothesis, pushed as it grows and cleared ("") when a segment commits or the take ends. */
  onInterimText?: (text: string) => void
  /** Reports whether a take is in flight, so the host can keep its chrome (and this button) mounted while dictating. */
  onActiveChange?: (active: boolean) => void
  /**
   * Insert a polished chunk into the editor with tracking so a later toggle can
   * swap it. When omitted, the polished pipeline is essentially disabled from
   * the editor's POV (the backend still emits the events, but nothing tracks
   * them) — surfaces that don't support inline swap can leave this off.
   */
  onInsertPolishedChunk?: (args: { chunkId: string; text: string }) => void
  /** Swap a tracked chunk's text. Returns false if the user edited inside it. */
  onChunkSwap?: (args: { chunkId: string; newText: string; expectedText: string }) => boolean
  /** Drop tracking for every chunk (post-session lock, or starting a new take). */
  onLockAllChunks?: () => void
  /**
   * Read the live text currently inside a tracked chunk from the editor.
   * The hook uses this to supply a true `expectedText` for swap calls — the
   * editor is the source of truth (mapping accounts for adjacent user edits),
   * so a parallel prediction in the hook drifts.
   */
  onGetChunkText?: (chunkId: string) => string | null
  disabled?: boolean
  className?: string
  language?: string
}

export function MicButton({
  workspaceId,
  onInsertText,
  onInterimText,
  onActiveChange,
  onInsertPolishedChunk,
  onChunkSwap,
  onLockAllChunks,
  onGetChunkText,
  disabled,
  className,
  language,
}: MicButtonProps) {
  const {
    state,
    supported,
    unsupportedReason,
    error,
    interimText,
    level,
    elapsedMs,
    maxDurationMs,
    chunks,
    hasUnlockedChunks,
    showOriginal,
    setShowOriginal,
    start,
    stop,
  } = useVoiceDictation({
    workspaceId,
    onCommittedText: onInsertText,
    onPolishedChunkInserted: onInsertPolishedChunk,
    onChunkSwap,
    onLockAllChunks,
    onGetChunkText,
    language,
  })

  // Tell the host when a take is in flight. The mobile composer collapses its
  // action bar (and this button) on blur; without this signal a tap-outside
  // mid-take would unmount the hook and abort the session, losing the take.
  const isActive = state === "connecting" || state === "recording" || state === "stopping"
  const onActiveChangeRef = useRef(onActiveChange)
  onActiveChangeRef.current = onActiveChange
  useEffect(() => {
    onActiveChangeRef.current?.(isActive)
  }, [isActive])
  useEffect(() => {
    return () => onActiveChangeRef.current?.(false)
  }, [])

  // Mirror the live hypothesis into the editor. Keep the callback in a ref so a
  // new function identity each render doesn't re-fire this on every keystroke,
  // and clear the ghost on unmount so a hidden mic can't strand preview text.
  const onInterimTextRef = useRef(onInterimText)
  onInterimTextRef.current = onInterimText
  useEffect(() => {
    onInterimTextRef.current?.(interimText)
  }, [interimText])
  useEffect(() => {
    return () => onInterimTextRef.current?.("")
  }, [])

  const tooltip = tooltipFor({ supported, unsupportedReason, state, error })

  // Detected once: under reduced-motion the recording ring stays static (the
  // bg tint alone signals the live state) rather than pulsing with the voice.
  const prefersReducedMotion = useRef(
    typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  ).current

  const recording = state === "recording"
  const actionLabel = actionLabelFor(state)
  const remainingMs = maxDurationMs !== null ? maxDurationMs - elapsedMs : null
  const nearCap = remainingMs !== null && remainingMs <= NEAR_CAP_MS
  // While recording (and motion is allowed), drive the halo rings from the live
  // input level so the button responds to speech instead of pulsing on a fixed
  // timer. The fill stays the static `bg-destructive/15` tint (below) so only
  // the ring moves; reduced-motion drops the ring and keeps the tint alone.
  const recordingStyle = recording && !prefersReducedMotion ? { boxShadow: recordingRingShadow(level) } : undefined

  const handleClick = () => {
    if (state === "recording" || state === "connecting") {
      stop()
      return
    }
    // Mid-teardown: ignore the click rather than re-entering start() before the
    // previous take has finished tearing down.
    if (state === "stopping") return
    start()
  }

  // The polish toggle rides above the mic. It only appears once there is at
  // least one polished chunk the user could actually swap — no dead chrome
  // while the session is silent. It stays visible through the post-session
  // grace window so a user can read the polished text and flip it after they
  // stop talking; once the chunks lock, the pill disappears on its own.
  const polishPillVisible = hasUnlockedChunks
  const polishLabel = showOriginal ? "Showing original" : "Showing polished"
  const polishToggleAria = showOriginal ? "Switch to polished transcript" : "Switch to original transcript"

  return (
    // Overlays live outside the tooltip trigger: when they were nested inside,
    // hovering the polish pill (a DOM descendant of the trigger) fired the mic
    // tooltip and the tooltip rendered over the pill, making it unclickable.
    // The trigger now wraps only the mic button itself.
    <span className="relative inline-flex">
      {/* Floating per-chunk inspector: appears when the user hovers (desktop)
          or taps (mobile) a polished chunk in the editor. Lives at MicButton
          level so it has access to the live chunks map without lifting state. */}
      {hasUnlockedChunks && <DictationChunkInspector chunks={chunks} onToggle={() => setShowOriginal(!showOriginal)} />}
      {recording && !polishPillVisible && (
        // Absolutely positioned so the running clock never shifts the composer
        // layout (INV-21). Switches to a remaining-time countdown with a
        // warning tint as the take nears the backend's hard cap. Hidden when
        // the polish pill is present — the pill occupies the same slot and the
        // clock would overlap it.
        <span
          className={cn(
            "pointer-events-none absolute bottom-full left-1/2 mb-1 -translate-x-1/2 select-none rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums leading-none whitespace-nowrap",
            nearCap ? "bg-destructive text-destructive-foreground" : "bg-muted text-muted-foreground"
          )}
        >
          {nearCap && remainingMs !== null ? `${formatClock(remainingMs)} left` : formatClock(elapsedMs)}
        </span>
      )}
      {polishPillVisible && (
        // Polish toggle: an inline pill anchored above the mic so it sits
        // right where the user is already looking after they stop talking.
        // Absolute positioning (matches the clock pill) keeps composer layout
        // stable (INV-21). The wrapper stays pointer-events-none so dead space
        // around the pill doesn't intercept clicks aimed at the mic; the pill
        // button re-enables pointer events for itself. The z-index keeps it
        // above the mic tooltip in case they ever overlap.
        <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 -translate-x-1/2 flex items-center gap-1 select-none whitespace-nowrap">
          {recording && (
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums leading-none",
                nearCap ? "bg-destructive text-destructive-foreground" : "bg-muted text-muted-foreground"
              )}
            >
              {nearCap && remainingMs !== null ? `${formatClock(remainingMs)} left` : formatClock(elapsedMs)}
            </span>
          )}
          <button
            type="button"
            aria-pressed={!showOriginal}
            aria-label={polishToggleAria}
            onClick={(e) => {
              e.stopPropagation()
              setShowOriginal(!showOriginal)
            }}
            className={cn(
              "pointer-events-auto inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none shadow-sm transition-colors",
              showOriginal
                ? "border-border bg-background text-muted-foreground hover:bg-muted"
                : "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15"
            )}
          >
            <Sparkles className={cn("h-2.5 w-2.5", showOriginal && "opacity-50")} aria-hidden />
            {polishLabel}
          </button>
        </span>
      )}
      {state === "error" && error && (
        // The tooltip alone is invisible on touch (no hover), so a dropped
        // take would look like it just stopped. Surface the reason inline as
        // a compact toast with a caret pointing at the mic, which stays the
        // tap-to-retry target. Absolute positioning keeps it from shifting
        // the composer layout (INV-21).
        <span
          role="status"
          className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 flex max-w-[15rem] -translate-x-1/2 select-none items-center gap-1.5 rounded-lg bg-destructive px-2.5 py-1.5 text-[11px] font-medium leading-snug text-destructive-foreground shadow-lg ring-1 ring-inset ring-white/15 animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-1 duration-150"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="text-left">{error}</span>
          <span
            aria-hidden
            className="absolute left-1/2 top-full size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[1px] bg-destructive"
          />
        </span>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={actionLabel}
            aria-pressed={state === "recording"}
            className={cn(
              "h-7 w-7 shrink-0 transition-shadow duration-100",
              // The persistent destructive tint signals the live state on its
              // own; the voice-reactive halo (below) adds motion only when the
              // user hasn't opted out via prefers-reduced-motion.
              recording && "bg-destructive/15 text-destructive",
              className
            )}
            style={recordingStyle}
            onClick={handleClick}
            disabled={disabled || !supported || state === "stopping"}
          >
            {state === "connecting" || state === "stopping" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Mic className="h-4 w-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </span>
  )
}
