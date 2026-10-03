import { useCallback } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Bell, Camera, Check, PenLine, Sparkles, UserPlus, X } from "lucide-react"
import { onboardingApi } from "@/api"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { useSettings, useSidebar, usePreferencesOptional } from "@/contexts"
import { usePushNotifications } from "@/hooks/use-push-notifications"
import { WS_SETTINGS_PARAM } from "@/components/workspace-settings/tab-config"
import { cn } from "@/lib/utils"
import { StreamTypes, WORKSPACE_ROLE_SLUGS, type Stream, type User, type WorkspaceBootstrap } from "@threahq/types"

interface GettingStartedTask {
  id: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  done: boolean
  /** Rendered under the label when the task can't proceed from here. */
  hint?: string
  onSelect: () => void
}

/**
 * "Write your first note": content in the auto-created system scratchpad, or
 * any scratchpad the user made themselves (scratchpads only persist server-side
 * on first send, so existence implies content). The Meet Ariadne scratchpad is
 * server-created on click, so it is excluded — meeting Ariadne isn't a note.
 */
export function hasWrittenFirstNote(
  streams: Array<Pick<Stream, "id" | "type"> & { lastMessagePreview?: unknown }>,
  onboardingStreamId: string | null
): boolean {
  return streams.some((s) => {
    if (s.id === onboardingStreamId) return false
    return s.type === StreamTypes.SYSTEM ? s.lastMessagePreview != null : s.type === StreamTypes.SCRATCHPAD
  })
}

export interface UseGettingStartedOptions {
  workspaceId: string
  currentUser: User | null
  /** True once the user has put content in a scratchpad (system note or own scratchpad). */
  hasWrittenNote: boolean
  /** The viewer's Meet Ariadne scratchpad (server state, synced across devices); its existence completes that task. */
  onboardingStreamId: string | null
  /** Workspace member count — the invite task completes once anyone else is in. */
  memberCount: number
  onCreateScratchpad: () => void | Promise<void>
}

export interface GettingStartedState {
  tasks: GettingStartedTask[]
  doneCount: number
  /** Render the sidebar card (preferences hydrated, not dismissed, tasks remain). */
  showCard: boolean
  /** Offer a re-entry point (account menu): dismissed but tasks remain. */
  canRestore: boolean
  dismiss: () => void
  restore: () => void
}

/**
 * New-user checklist state, shared by the sidebar card and the account menu's
 * "Getting started" re-entry row. Every task's completion is DERIVED from real
 * state (push subscription, avatar, stream content, member count) rather than
 * tracked, so the checklist self-completes and never shows a stale "to do".
 * The only persisted bit is the explicit dismissal (`gettingStartedDismissed`
 * in user preferences, synced across devices) — and it's reversible: restore()
 * clears it so the card comes back until the tasks are actually done.
 */
export function useGettingStarted({
  workspaceId,
  currentUser,
  hasWrittenNote,
  onboardingStreamId,
  memberCount,
  onCreateScratchpad,
}: UseGettingStartedOptions): GettingStartedState {
  const preferencesContext = usePreferencesOptional()
  const { openSettings } = useSettings()
  const { collapseOnMobile } = useSidebar()
  const [, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  // Mounting the hook here also gives the app a persistent auto-resubscribe
  // surface — previously it only ran while the notifications settings tab
  // was open.
  const push = usePushNotifications(workspaceId)

  const openProfileSettings = useCallback(() => {
    collapseOnMobile()
    openSettings("profile")
  }, [collapseOnMobile, openSettings])

  const meetAriadne = useCallback(async () => {
    try {
      const { streamId } = await onboardingApi.meetAriadne(workspaceId)
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) =>
        old ? { ...old, onboardingStreamId: streamId } : old
      )
      collapseOnMobile()
      navigate(`/w/${workspaceId}/s/${streamId}`)
    } catch {
      toast.error("Couldn't start the conversation with Ariadne")
    }
  }, [workspaceId, queryClient, collapseOnMobile, navigate])

  const openInvites = useCallback(() => {
    collapseOnMobile()
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set(WS_SETTINGS_PARAM, "users")
        return next
      },
      { replace: true }
    )
  }, [collapseOnMobile, setSearchParams])

  const dismiss = useCallback(() => {
    void preferencesContext?.updatePreference("gettingStartedDismissed", true)
  }, [preferencesContext])

  // No collapseOnMobile here — the card being restored lives in the sidebar,
  // so collapsing it would hide the thing the user just asked to see.
  const restore = useCallback(() => {
    void preferencesContext?.updatePreference("gettingStartedDismissed", false)
  }, [preferencesContext])

  const tasks: GettingStartedTask[] = []

  if (currentUser) {
    if (push.permission !== "unsupported" && !push.pushDisabledOnServer) {
      tasks.push({
        id: "notifications",
        label: "Turn on notifications",
        icon: Bell,
        done: push.isSubscribed,
        hint:
          push.permission === "denied" ? "Blocked by the browser — allow notifications for this site first" : undefined,
        onSelect: () => void push.requestPermission(),
      })
    }

    tasks.push({
      id: "avatar",
      label: "Add a profile photo",
      icon: Camera,
      done: currentUser.avatarUrl != null,
      onSelect: openProfileSettings,
    })

    tasks.push({
      id: "first-note",
      label: "Write your first note",
      icon: PenLine,
      done: hasWrittenNote,
      onSelect: () => void onCreateScratchpad(),
    })

    tasks.push({
      id: "meet-ariadne",
      label: "Meet Ariadne",
      icon: Sparkles,
      done: onboardingStreamId != null,
      onSelect: () => void meetAriadne(),
    })

    const canInvite = currentUser.role === WORKSPACE_ROLE_SLUGS.OWNER || currentUser.role === WORKSPACE_ROLE_SLUGS.ADMIN
    if (canInvite) {
      tasks.push({
        id: "invite",
        label: "Invite your team",
        icon: UserPlus,
        done: memberCount > 1,
        onSelect: openInvites,
      })
    }
  }

  const doneCount = tasks.filter((task) => task.done).length
  const allDone = tasks.length === 0 || doneCount === tasks.length
  // Until preferences hydrate we can't know whether the card was dismissed —
  // surface nothing rather than flashing it in.
  const hydrated = Boolean(currentUser && preferencesContext?.preferences)
  const dismissed = preferencesContext?.preferences?.gettingStartedDismissed ?? false

  return {
    tasks,
    doneCount,
    showCard: hydrated && !dismissed && !allDone,
    canRestore: hydrated && dismissed && !allDone,
    dismiss,
    restore,
  }
}

/** Checklist card pinned above the sidebar footer. Renders from useGettingStarted state. */
export function GettingStarted({ state }: { state: GettingStartedState }) {
  if (!state.showCard) return null
  const { tasks, doneCount, dismiss } = state

  return (
    <div className="mb-2 rounded-lg border bg-muted/30 p-1.5">
      <div className="flex items-center justify-between pb-0.5 pl-2 pr-0.5">
        <p className="text-xs font-medium text-muted-foreground">
          Getting started · {doneCount}/{tasks.length}
        </p>
        <button
          type="button"
          aria-label="Dismiss getting started"
          onClick={dismiss}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <ul className="flex flex-col">
        {tasks.map((task) => (
          <li key={task.id}>
            {task.done ? (
              <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground">
                <Check aria-label="Done" className="h-4 w-4 shrink-0 text-green-600" />
                <span className="truncate line-through">{task.label}</span>
              </div>
            ) : (
              <button
                type="button"
                onClick={task.onSelect}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                  "transition-colors hover:bg-muted"
                )}
              >
                <task.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{task.label}</span>
                  {task.hint && <span className="block text-xs text-muted-foreground">{task.hint}</span>}
                </span>
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
