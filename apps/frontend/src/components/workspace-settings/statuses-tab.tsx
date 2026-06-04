import { useEffect, useMemo, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { BellOff, Smile, Trash2, Plus } from "lucide-react"
import {
  WORKSPACE_PERMISSION_SCOPES,
  SYSTEM_DEFAULT_STATUSES,
  STATUS_TEXT_MAX_LENGTH,
  MAX_STATUS_PRESETS,
  isStatusContentful,
  presetPausesNotifications,
  type StatusPreset,
  type WorkspaceBootstrap,
} from "@threa/types"
import { workspaceSettingsApi } from "@/api"
import { workspaceKeys, useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { hasPermission } from "@/lib/permissions"
import { STATUS_DURATION_OPTIONS, durationsEqual } from "@/lib/status"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ReactionEmojiPicker } from "@/components/timeline/reaction-emoji-picker"

interface StatusesTabProps {
  workspaceId: string
}

function durationIdForPreset(preset: StatusPreset): string {
  return STATUS_DURATION_OPTIONS.find((o) => durationsEqual(o.duration, preset.defaultDuration))?.id ?? "never"
}

/**
 * Workspace-default status presets. Members see these in the status picker
 * (additive to their own custom presets); the system presets are the fallback
 * when a workspace hasn't customized the list. Editing is admin-gated.
 */
export function StatusesTab({ workspaceId }: StatusesTabProps) {
  const queryClient = useQueryClient()
  const bootstrap = useCachedWorkspaceBootstrap(workspaceId)
  const canManage = hasPermission(bootstrap?.viewerPermissions, WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)
  const { toEmoji, toShortcode } = useWorkspaceEmoji(workspaceId)

  const saved = useMemo<StatusPreset[]>(
    () => bootstrap?.workspaceSettings?.userStatusPresets ?? SYSTEM_DEFAULT_STATUSES,
    [bootstrap?.workspaceSettings?.userStatusPresets]
  )

  const [draft, setDraft] = useState<StatusPreset[]>(saved)
  useEffect(() => {
    setDraft(saved)
  }, [saved])

  const mutation = useMutation({
    mutationFn: (userStatusPresets: StatusPreset[]) => workspaceSettingsApi.update(workspaceId, { userStatusPresets }),
    onSuccess: (settings) => {
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) =>
        old ? { ...old, workspaceSettings: settings } : old
      )
      toast.success("Workspace statuses saved")
    },
    onError: () => toast.error("Failed to save workspace statuses"),
  })

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const allValid = draft.every((p) => isStatusContentful(p))

  const updatePreset = (index: number, patch: Partial<StatusPreset>) => {
    setDraft((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)))
  }

  const removePreset = (index: number) => {
    setDraft((prev) => prev.filter((_, i) => i !== index))
  }

  const addPreset = () => {
    setDraft((prev) => [
      ...prev,
      { id: `status_${crypto.randomUUID()}`, emoji: null, text: "", defaultDuration: null, pausesNotifications: false },
    ])
  }

  return (
    <div className="space-y-4 p-1">
      <div>
        <h3 className="text-sm font-medium">Status presets</h3>
        <p className="text-sm text-muted-foreground">
          The statuses members can pick from. Each can carry an emoji, text, and a default duration. Toggle the bell to
          have a status pause notifications while it's active. Members can also save their own personal presets on top
          of these.
        </p>
      </div>

      <div className="space-y-2">
        {draft.map((preset, index) => {
          const glyph = preset.emoji ? toEmoji(preset.emoji) : null
          return (
            <div key={preset.id} className="flex items-center gap-2">
              <ReactionEmojiPicker
                workspaceId={workspaceId}
                onSelect={(picked) => updatePreset(index, { emoji: toShortcode(picked) })}
                trigger={
                  <button
                    type="button"
                    disabled={!canManage}
                    aria-label="Pick emoji"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-input text-base hover:bg-muted/50 disabled:opacity-50"
                  >
                    {glyph ?? <Smile className="h-4 w-4 text-muted-foreground" />}
                  </button>
                }
              />
              <Input
                value={preset.text ?? ""}
                onChange={(e) => updatePreset(index, { text: e.target.value })}
                maxLength={STATUS_TEXT_MAX_LENGTH}
                placeholder="Status text"
                disabled={!canManage}
                className="flex-1"
              />
              <Select
                value={durationIdForPreset(preset)}
                onValueChange={(id) =>
                  updatePreset(index, {
                    defaultDuration: STATUS_DURATION_OPTIONS.find((o) => o.id === id)?.duration ?? null,
                  })
                }
                disabled={!canManage}
              >
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_DURATION_OPTIONS.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant={presetPausesNotifications(preset) ? "secondary" : "ghost"}
                size="icon"
                aria-label="Pause notifications for this status"
                aria-pressed={presetPausesNotifications(preset)}
                title="Pause notifications while this status is active"
                disabled={!canManage}
                onClick={() => updatePreset(index, { pausesNotifications: !presetPausesNotifications(preset) })}
              >
                <BellOff className="h-4 w-4" />
              </Button>
              {canManage && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove status"
                  onClick={() => removePreset(index)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          )
        })}
      </div>

      {canManage && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addPreset}
          disabled={draft.length >= MAX_STATUS_PRESETS}
        >
          <Plus className="h-4 w-4 mr-1" />
          Add status
        </Button>
      )}

      {canManage ? (
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={mutation.isPending}
            onClick={() => setDraft(SYSTEM_DEFAULT_STATUSES)}
          >
            Use system defaults
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!dirty || !allValid || mutation.isPending}
            onClick={() => mutation.mutate(draft)}
          >
            Save statuses
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Only workspace admins can change status presets.</p>
      )}
    </div>
  )
}
