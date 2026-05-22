import { useEffect } from "react"
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
  disabled?: boolean
  /** Notifies the composer when dictation is live so it can keep the button visible while typing-detection would otherwise hide it. */
  onActiveChange?: (active: boolean) => void
  className?: string
  language?: string
}

export function MicButton({
  workspaceId,
  onInsertText,
  disabled,
  onActiveChange,
  className,
  language,
}: MicButtonProps) {
  const { state, supported, unsupportedReason, error, start, stop } = useVoiceDictation({
    workspaceId,
    onCommittedText: onInsertText,
    language,
  })

  const isActive = state === "connecting" || state === "recording" || state === "stopping"

  useEffect(() => {
    onActiveChange?.(isActive)
  }, [isActive, onActiveChange])

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
