import { useEffect, useRef } from "react"
import { Mic, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useVoiceDictation, type VoiceDictationState } from "@/hooks/use-voice-dictation"

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
  const { state, supported, unsupportedReason, error, interimText, start, stop } = useVoiceDictation({
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
        <span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={state === "recording" ? "Stop dictation" : "Dictate a message"}
            aria-pressed={state === "recording"}
            className={cn(
              "h-7 w-7 shrink-0",
              state === "recording" && "bg-destructive/15 text-destructive animate-pulse",
              className
            )}
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
