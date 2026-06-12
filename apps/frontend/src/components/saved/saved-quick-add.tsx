import { useState } from "react"
import { Plus } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useSaveMessage } from "@/hooks/use-saved"

interface SavedQuickAddProps {
  workspaceId: string
}

/**
 * Inline composer for standalone to-dos at the top of the Saved tab. Enter or
 * the plus button creates the item; context (note) and reminders are added
 * afterwards from the row, keeping capture itself one keystroke cheap.
 */
export function SavedQuickAdd({ workspaceId }: SavedQuickAddProps) {
  const [title, setTitle] = useState("")
  const saveMutation = useSaveMessage(workspaceId)

  const submit = () => {
    const trimmed = title.trim()
    if (!trimmed || saveMutation.isPending) return
    saveMutation.mutate(
      { title: trimmed },
      {
        onSuccess: () => setTitle(""),
        onError: () => toast.error("Could not add to-do"),
      }
    )
  }

  return (
    <form
      className="flex items-center gap-2 px-4 py-2 border-b border-border/50"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Add a to-do…"
        maxLength={300}
        className="h-8 text-sm"
        aria-label="New to-do title"
      />
      <Button
        type="submit"
        size="icon"
        variant="ghost"
        className="h-8 w-8 shrink-0"
        disabled={!title.trim() || saveMutation.isPending}
        title="Add to-do"
      >
        <Plus className="h-4 w-4" />
      </Button>
    </form>
  )
}
