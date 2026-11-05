import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { CircleAlert } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { STREAM_BRIEF_MAX_CHARS, type Stream } from "@threahq/types"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { ApiError } from "@/api/client"
import type { StreamBrief } from "@/api"
import { useStreamBrief, useUpdateStreamBrief } from "@/hooks/use-stream-brief"
import { streamKeys } from "@/hooks/use-streams"
import { formatRelativeTime } from "@/lib/dates"
import { cn } from "@/lib/utils"
import {
  SETTING_CONTROL_HEIGHT,
  SettingAddButton,
  SettingEmptyNote,
  SettingNotice,
  SettingRow,
} from "@/components/settings/setting-primitives"
import { SETTING_INPUT_FRAME, SETTING_MUTED_NOTE_TEXT, SETTING_NOTE_TEXT } from "@/components/settings/setting-text"

/**
 * The Brief row: read/correct a stream's brief from settings (roadmap 4.3). The brief is
 * plain markdown (no `content_json` twin — 4.1), so this edits a textarea and
 * renders the markdown for the view, rather than reusing the rich message
 * editor. A concurrent edit surfaces inline (no toast, INV-63); saving again
 * overwrites, or the editor can load the other version first.
 */
export function BriefSection({
  workspaceId,
  stream,
  locked = false,
  description,
}: {
  workspaceId: string
  stream: Stream
  locked?: boolean
  /** Copy that depends on the stream, replacing the registry description. */
  description?: ReactNode
}) {
  const queryClient = useQueryClient()
  const { data: brief, isLoading } = useStreamBrief(workspaceId, stream.id)
  const updateMutation = useUpdateStreamBrief(workspaceId, stream.id)

  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [hadConflict, setHadConflict] = useState(false)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const counterId = useId()

  // The button that opened the editor is gone, so focus follows into it.
  useEffect(() => {
    if (isEditing) editorRef.current?.focus()
  }, [isEditing])

  const savedContent = brief?.content ?? ""
  const baseVersion = brief?.version ?? 0

  const startEditing = () => {
    setDraft(savedContent)
    setHadConflict(false)
    setIsEditing(true)
  }

  const closeEditor = () => {
    setIsEditing(false)
    setHadConflict(false)
  }

  const handleSave = () => {
    const content = draft.trim()
    if (content === savedContent.trim() || updateMutation.isPending) return
    updateMutation.mutate(
      { content, version: baseVersion },
      {
        onSuccess: closeEditor,
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

  let control: ReactNode = null
  let body: ReactNode
  if (isLoading) {
    body = <SettingEmptyNote>Loading brief…</SettingEmptyNote>
  } else if (isEditing) {
    body = (
      <div className="space-y-3">
        {hadConflict && (
          <SettingNotice icon={CircleAlert} role="status">
            Someone else updated this brief while you were editing. Save again to overwrite their version, or{" "}
            <button
              type="button"
              className="rounded-sm underline underline-offset-2 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                setDraft(savedContent)
                setHadConflict(false)
              }}
            >
              load their changes
            </button>{" "}
            to start from it.
          </SettingNotice>
        )}
        <Textarea
          ref={editorRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={STREAM_BRIEF_MAX_CHARS}
          placeholder="e.g. This channel tracks the Q3 launch. Decisions: ship behind a flag; owner is @sam. Prefer terse updates."
          aria-label="Stream brief editor"
          aria-describedby={counterId}
          className="min-h-[160px] font-mono text-sm"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span id={counterId} className={cn("tabular-nums text-muted-foreground", SETTING_NOTE_TEXT)}>
            {draft.length}/{STREAM_BRIEF_MAX_CHARS}
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              className={SETTING_CONTROL_HEIGHT}
              onClick={closeEditor}
              disabled={updateMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className={SETTING_CONTROL_HEIGHT}
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
    control = (
      <Button
        type="button"
        variant="outline"
        className={SETTING_CONTROL_HEIGHT}
        onClick={startEditing}
        disabled={locked}
      >
        Edit
      </Button>
    )
    body = (
      <div className="space-y-1.5">
        <div className={SETTING_INPUT_FRAME}>
          <MarkdownContent content={savedContent} className="text-sm" />
        </div>
        <p className={SETTING_MUTED_NOTE_TEXT}>
          Updated {formatRelativeTime(new Date(brief.updatedAt), undefined, undefined, { terse: true })}
        </p>
      </div>
    )
  } else {
    control = (
      <SettingAddButton onClick={startEditing} disabled={locked}>
        Add brief
      </SettingAddButton>
    )
    body = <SettingEmptyNote>No brief yet.</SettingEmptyNote>
  }

  return (
    <SettingRow setting="stream-brief" labelFor={false} description={description} control={control}>
      {body}
    </SettingRow>
  )
}
