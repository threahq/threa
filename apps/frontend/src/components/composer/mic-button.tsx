import { useEffect, useRef } from "react"
import { Mic, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useVoiceDictation, type VoiceDictationState } from "@/hooks/use-voice-dictation"

// Surface the cap warning in the final stretch so the auto-stop isn't a surprise.
const NEAR_CAP_MS = 60_000

export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
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
  disabled?: boolean
  className?: string
  language?: string
}

export function MicButton({
  workspaceId,
  onInsertText,
  onInterimText,
  onActiveChange,
  disabled,
  className,
  language,
}: MicButtonProps) {
  const { state, supported, unsupportedReason, error, interimText, level, elapsedMs, maxDurationMs, start, stop } =
    useVoiceDictation({
      workspaceId,
      onCommittedText: onInsertText,
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
  const remainingMs = maxDurationMs !== null ? maxDurationMs - elapsedMs : null
  const nearCap = remainingMs !== null && remainingMs <= NEAR_CAP_MS
  // A voice-reactive ring while recording: spread + opacity track the live input
  // level so the button visibly responds to speech instead of a fixed pulse.
  const recordingRing =
    recording && !prefersReducedMotion
      ? {
          boxShadow: `0 0 0 ${(1 + level * 5).toFixed(2)}px hsl(var(--destructive) / ${(0.12 + level * 0.28).toFixed(3)})`,
        }
      : undefined

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

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative inline-flex">
          {recording && (
            // Absolutely positioned so the running clock never shifts the
            // composer layout (INV-21). Switches to a remaining-time countdown
            // with a warning tint as the take nears the backend's hard cap.
            <span
              className={cn(
                "pointer-events-none absolute bottom-full left-1/2 mb-1 -translate-x-1/2 select-none rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums leading-none whitespace-nowrap",
                nearCap ? "bg-destructive text-destructive-foreground" : "bg-muted text-muted-foreground"
              )}
            >
              {nearCap && remainingMs !== null ? `${formatClock(remainingMs)} left` : formatClock(elapsedMs)}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={state === "recording" ? "Stop dictation" : "Dictate a message"}
            aria-pressed={state === "recording"}
            className={cn(
              "h-7 w-7 shrink-0 transition-shadow duration-100",
              recording && "bg-destructive/15 text-destructive",
              recording && prefersReducedMotion && "animate-pulse",
              className
            )}
            style={recordingRing}
            onClick={handleClick}
            disabled={disabled || !supported || state === "stopping"}
          >
            {state === "connecting" || state === "stopping" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Mic className="h-4 w-4" />
            )}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
