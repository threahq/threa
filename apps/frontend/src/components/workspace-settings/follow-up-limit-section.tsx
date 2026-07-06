import { useEffect, useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  WORKSPACE_PERMISSION_SCOPES,
  DEFAULT_MAX_PENDING_FOLLOW_UPS,
  MAX_PENDING_FOLLOW_UPS_MIN,
  MAX_PENDING_FOLLOW_UPS_MAX,
  type WorkspaceBootstrap,
  type WorkspaceSettings,
} from "@threa/types"
import { workspaceSettingsApi } from "@/api"
import { workspaceKeys, useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { hasPermission } from "@/lib/permissions"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

interface FollowUpLimitSectionProps {
  workspaceId: string
}

/**
 * Workspace cap on the assistant's pending follow-ups per stream (roadmap 1.4).
 * Editing is gated to admins; others see the current value read-only. The tool's
 * self-reported limit reflects this the next time the assistant schedules.
 */
export function FollowUpLimitSection({ workspaceId }: FollowUpLimitSectionProps) {
  const queryClient = useQueryClient()
  const bootstrap = useCachedWorkspaceBootstrap(workspaceId)
  const canManage = hasPermission(bootstrap?.viewerPermissions, WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)
  const settings = bootstrap?.workspaceSettings ?? null
  const savedValue = settings?.maxPendingFollowUps ?? DEFAULT_MAX_PENDING_FOLLOW_UPS

  const [draft, setDraft] = useState(String(savedValue))
  // Tracks whether the user has actually edited since the last commit — not mere
  // focus. Guards the reconverge effect and gates the save: only unsaved
  // keystrokes must survive a concurrent broadcast; a focused-but-untouched field
  // should still reflect the new value and must never save the stale one.
  const dirtyRef = useRef(false)
  // Reconverge on the stored value when it changes (another admin's edit — or our
  // own second tab — broadcasts through the bootstrap cache via
  // `workspace_settings:updated`). Skip only while there are unsaved keystrokes so
  // the broadcast can't overwrite them mid-edit; `commit` reconciles on blur.
  useEffect(() => {
    if (dirtyRef.current) return
    setDraft(String(savedValue))
  }, [savedValue])

  const mutation = useMutation({
    mutationFn: (maxPendingFollowUps: number) => workspaceSettingsApi.update(workspaceId, { maxPendingFollowUps }),
    onMutate: async (maxPendingFollowUps) => {
      await queryClient.cancelQueries({ queryKey: workspaceKeys.bootstrap(workspaceId) })
      let previousSettings: WorkspaceSettings | null = null
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
        previousSettings = old?.workspaceSettings ?? null
        return old?.workspaceSettings
          ? { ...old, workspaceSettings: { ...old.workspaceSettings, maxPendingFollowUps } }
          : old
      })
      return { previousSettings }
    },
    onError: (_err, _next, context) => {
      if (context?.previousSettings) {
        const restored = context.previousSettings
        queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) =>
          old ? { ...old, workspaceSettings: restored } : old
        )
      }
      setDraft(String(savedValue))
      toast.error("Failed to save the follow-up limit")
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) =>
        old ? { ...old, workspaceSettings: saved } : old
      )
    },
  })

  // Save on blur, but only a real edit. A focused-but-untouched field never saves
  // (else a concurrent broadcast that moved `savedValue` would be stomped by the
  // stale draft). Out-of-range or non-numeric input reverts to the stored value
  // rather than snapping to a boundary the user didn't type — matching the sibling
  // admin numeric inputs in `pages/ai-usage-admin.tsx`.
  const commit = () => {
    if (!dirtyRef.current) {
      setDraft(String(savedValue))
      return
    }
    dirtyRef.current = false
    const parsed = Number.parseInt(draft, 10)
    if (Number.isNaN(parsed) || parsed < MAX_PENDING_FOLLOW_UPS_MIN || parsed > MAX_PENDING_FOLLOW_UPS_MAX) {
      setDraft(String(savedValue))
      return
    }
    if (parsed === savedValue) {
      setDraft(String(savedValue))
      return
    }
    setDraft(String(parsed))
    mutation.mutate(parsed)
  }

  return (
    <div>
      <Label htmlFor="max-pending-follow-ups" className="text-sm font-medium">
        Assistant follow-ups
      </Label>
      <p className="text-xs text-muted-foreground mt-0.5">
        How many pending follow-ups the assistant may hold per stream before it stops scheduling more.
      </p>
      {canManage ? (
        <Input
          id="max-pending-follow-ups"
          type="number"
          min={MAX_PENDING_FOLLOW_UPS_MIN}
          max={MAX_PENDING_FOLLOW_UPS_MAX}
          className="mt-2 w-24"
          value={draft}
          disabled={settings == null || mutation.isPending}
          onChange={(e) => {
            dirtyRef.current = true
            setDraft(e.target.value)
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur()
          }}
        />
      ) : (
        <p className="text-sm text-muted-foreground mt-2">{savedValue}</p>
      )}
    </div>
  )
}
