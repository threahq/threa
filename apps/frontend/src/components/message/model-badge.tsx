import { Sparkles } from "lucide-react"
import { modelDisplayName } from "@/lib/model-display"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/**
 * Whose brain is talking. A subagent is the SAME persona on another model, so
 * without this the thread reads as the persona's ordinary voice. Sits in the
 * message header beside the name, like the "via API" pill.
 *
 * Muted, never gold: on this surface gold means "waiting for you" (the card's one
 * state that owes the reader something), and a chip on every subagent message
 * would spend that signal on provenance.
 */
export function ModelBadge({ modelId }: { modelId: string }) {
  const label = modelDisplayName(modelId)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-px text-[10px] font-semibold text-muted-foreground">
          <Sparkles className="size-2.5" aria-hidden="true" />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent>Delegated to {label} for this thread</TooltipContent>
    </Tooltip>
  )
}
