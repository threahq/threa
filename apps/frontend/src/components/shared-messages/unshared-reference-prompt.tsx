import type { ShareFlavor } from "@threahq/types"
import { Button } from "@/components/ui/button"
import { FitCopy } from "@/components/composer/send-ask"
import { AUDIENCE_TONE } from "@/components/editor/reference-audience-tone"
import { useShareReferences } from "@/hooks/use-unshared-references"
import { cn } from "@/lib/utils"

const COPY: Record<ShareFlavor, { full: string; short: string }> = {
  pointer: { full: "Readers can't see the shared message", short: "Readers can't see it" },
  quote: { full: "Readers can't open the quoted message", short: "Readers can't open it" },
}

interface UnsharedReferencePromptProps {
  workspaceId: string
  /** The sent message carrying the unshared reference. */
  messageId: string
  flavor: ShareFlavor
  className?: string
}

/** Author-only ask under a share/quote that went out without a grant; [Share it] grants every reference in the message. */
export function UnsharedReferencePrompt({ workspaceId, messageId, flavor, className }: UnsharedReferencePromptProps) {
  const share = useShareReferences(workspaceId)
  const tone = AUDIENCE_TONE.unreachable
  const Icon = tone.icon
  return (
    <div
      data-testid="unshared-reference-prompt"
      className={cn("flex min-w-0 items-center gap-2 [container-type:inline-size]", className)}
    >
      <span role="status" className={cn("flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium", tone.text)}>
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">
          <FitCopy compact={false} copy={COPY[flavor]} />
        </span>
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 shrink-0 px-2.5"
        disabled={share.isPending}
        onClick={() => share.mutate(messageId)}
      >
        Share it
      </Button>
    </div>
  )
}
