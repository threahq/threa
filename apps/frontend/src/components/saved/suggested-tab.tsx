import { Sparkles } from "lucide-react"
import { toast } from "sonner"
import { useSuggestedList, useAcceptSuggestion, useDismissSuggestion } from "@/hooks/use-saved-suggestions"
import { SavedSkeleton } from "@/components/saved/saved-skeleton"
import { SavedSuggestionItem } from "@/components/saved/saved-suggestion-item"

interface SuggestedTabProps {
  workspaceId: string
}

/**
 * The quiet collector's pull-only pile. Nothing here was created for you — the
 * system proposes, you dispose: Add promotes a candidate into Saved, Dismiss
 * removes it and teaches the extractor. Empty is the resting state.
 */
export function SuggestedTab({ workspaceId }: SuggestedTabProps) {
  const { items, isLoading } = useSuggestedList(workspaceId)
  const acceptMutation = useAcceptSuggestion(workspaceId)
  const dismissMutation = useDismissSuggestion(workspaceId)

  const handleAccept = (id: string) => {
    acceptMutation.mutate(id, {
      onSuccess: () => toast.success("Added to Saved"),
      onError: () => toast.error("Could not add to Saved"),
    })
  }

  const handleDismiss = (id: string) => {
    dismissMutation.mutate(id, {
      onError: () => toast.error("Could not dismiss"),
    })
  }

  if (isLoading) return <SavedSkeleton />

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-8 text-center">
        <div className="w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center mb-4">
          <Sparkles className="w-6 h-6 text-amber-500" />
        </div>
        <h2 className="text-lg font-semibold mb-1">No suggestions right now</h2>
        <p className="text-sm text-muted-foreground max-w-md">
          As you chat, Threa quietly notices to-dos meant for you and collects them here. Nothing is ever added to your
          list without you — add the ones that matter, dismiss the rest.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {items.map((suggestion) => (
        <SavedSuggestionItem
          key={suggestion.id}
          suggestion={suggestion}
          workspaceId={workspaceId}
          onAccept={() => handleAccept(suggestion.id)}
          onDismiss={() => handleDismiss(suggestion.id)}
          pending={acceptMutation.isPending || dismissMutation.isPending}
        />
      ))}
    </div>
  )
}
