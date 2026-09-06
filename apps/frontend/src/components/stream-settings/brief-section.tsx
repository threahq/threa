import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { StreamTypes, STREAM_BRIEF_MAX_CHARS, type Stream } from "@threahq/types"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { ApiError } from "@/api/client"
import type { StreamBrief } from "@/api"
import { useStreamBrief, useUpdateStreamBrief } from "@/hooks/use-stream-brief"
import { streamKeys } from "@/hooks/use-streams"
import { formatRelativeTime } from "@/lib/dates"

/**
 * Read/correct a stream's brief from settings (roadmap 4.3). The brief is
 * plain markdown (no `content_json` twin — 4.1), so this edits a textarea and
 * renders the markdown for the view, rather than reusing the rich message
 * editor. A concurrent edit surfaces inline (no toast, INV-63); saving again
 * overwrites, or the editor can load the other version first.
 */
export function BriefSection({ workspaceId, stream }: { workspaceId: string; stream: Stream }) {
  const queryClient = useQueryClient()
  const { data: brief, isLoading } = useStreamBrief(workspaceId, stream.id)
  const updateMutation = useUpdateStreamBrief(workspaceId, stream.id)

  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [hadConflict, setHadConflict] = useState(false)

  const isThread = stream.type === StreamTypes.THREAD
  const savedContent = brief?.content ?? ""
  const baseVersion = brief?.version ?? 0

  const startEditing = () => {
    setDraft(savedContent)
    setHadConflict(false)
    setIsEditing(true)
  }

  const cancelEditing = () => {
    setIsEditing(false)
    setHadConflict(false)
  }

  const handleSave = () => {
    const content = draft.trim()
    if (content === savedContent.trim() || updateMutation.isPending) return
    updateMutation.mutate(
      { content, version: baseVersion },
      {
        onSuccess: () => {
          setIsEditing(false)
          setHadConflict(false)
        },
        onError: (error) => {
          if (ApiError.isApiError(error) && error.code === "BRIEF_VERSION_CONFLICT") {
            // Refresh the known row to the writer's version so the next save
            // carries the current version (overwrites), and keep the editor
            // open with the user's in-progress text — nothing is lost silently.
            const current = (error.details?.current ?? null) as StreamBrief | null
            if (current) {
              queryClient.setQueryData<StreamBrief | null>(streamKeys.brief(workspaceId, stream.id), current)
            }
            setHadConflict(true)
            return
          }
          toast.error(error instanceof Error ? error.message : "Failed to save brief")
        },
      }
    )
  }

  let body: React.ReactNode
  if (isLoading) {
    body = <p className="text-xs text-muted-foreground">Loading brief…</p>
  } else if (isEditing) {
    body = (
      <div className="space-y-2">
        {hadConflict && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            Someone else updated this brief while you were editing. Save again to overwrite their version, or{" "}
            <button
              type="button"
              className="font-medium underline underline-offset-2"
              onClick={() => {
                setDraft(savedContent)
                setHadConflict(false)
              }}
            >
              load their changes
            </button>{" "}
            to start from it.
          </p>
        )}
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={STREAM_BRIEF_MAX_CHARS}
          placeholder="e.g. This channel tracks the Q3 launch. Decisions: ship behind a flag; owner is @sam. Prefer terse updates."
          aria-label="Stream brief editor"
          className="min-h-[160px] font-mono text-xs"
        />
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">
            {draft.length}/{STREAM_BRIEF_MAX_CHARS}
          </span>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={cancelEditing} disabled={updateMutation.isPending}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleSave}
              disabled={draft.trim() === savedContent.trim() || updateMutation.isPending}
            >
              {updateMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </div>
    )
  } else if (brief && savedContent.trim()) {
    body = (
      <div className="space-y-2">
        <div className="rounded-lg border border-input bg-card p-3">
          <MarkdownContent content={savedContent} className="text-sm" />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">
            Updated {formatRelativeTime(new Date(brief.updatedAt), undefined, undefined, { terse: true })}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={startEditing}>
            Edit
          </Button>
        </div>
      </div>
    )
  } else {
    body = (
      <div className="rounded-lg border border-dashed border-input p-4 text-center">
        <p className="text-xs text-muted-foreground">No brief yet.</p>
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={startEditing}>
          Add a brief
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-sm font-medium">Brief</Label>
        <p className="text-xs text-muted-foreground">
          A short standing context Ariadne reads on every turn in this {isThread ? "thread" : "stream"} — goals,
          decisions, and preferences that outlive any one conversation.
          {isThread ? " This brief is shared with the parent channel." : ""}
        </p>
      </div>

      {body}
    </div>
  )
}
