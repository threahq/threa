import { useCallback } from "react"
import { useSearchParams } from "react-router-dom"
import { Bell, Camera, Check, PenLine, UserPlus, X } from "lucide-react"
import { useSettings, useSidebar, usePreferencesOptional } from "@/contexts"
import { usePushNotifications } from "@/hooks/use-push-notifications"
import { WS_SETTINGS_PARAM } from "@/components/workspace-settings/tab-config"
import { cn } from "@/lib/utils"
import { WORKSPACE_ROLE_SLUGS, type User } from "@threa/types"

interface GettingStartedTask {
  id: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  done: boolean
  /** Rendered under the label when the task can't proceed from here. */
  hint?: string
  onSelect: () => void
}

interface GettingStartedProps {
  workspaceId: string
  currentUser: User | null
  /** True once the user has put content in a scratchpad (system note or own scratchpad). */
  hasWrittenNote: boolean
  /** Workspace member count — the invite task completes once anyone else is in. */
  memberCount: number
  onCreateScratchpad: () => void | Promise<void>
}

/**
 * New-user checklist pinned above the sidebar footer. Every task's completion
 * is DERIVED from real state (push subscription, avatar, stream content,
 * member count) rather than tracked, so the card self-completes and never
 * shows a stale "to do". The only persisted bit is the explicit dismissal
 * (`gettingStartedDismissed` in user preferences, synced across devices).
 */
export function GettingStarted({
  workspaceId,
  currentUser,
  hasWrittenNote,
  memberCount,
  onCreateScratchpad,
}: GettingStartedProps) {
  const preferencesContext = usePreferencesOptional()
  const { openSettings } = useSettings()
  const { collapseOnMobile } = useSidebar()
  const [, setSearchParams] = useSearchParams()
  // Mounting the hook here also gives the app a persistent auto-resubscribe
  // surface — previously it only ran while the notifications settings tab
  // was open.
  const push = usePushNotifications(workspaceId)

  const openProfileSettings = useCallback(() => {
    collapseOnMobile()
    openSettings("profile")
  }, [collapseOnMobile, openSettings])

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

  // Until preferences hydrate we can't know whether the card was dismissed —
  // render nothing rather than flashing it in.
  if (!currentUser || !preferencesContext?.preferences) return null
  if (preferencesContext.preferences.gettingStartedDismissed) return null

  const tasks: GettingStartedTask[] = []

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

  const doneCount = tasks.filter((task) => task.done).length
  if (doneCount === tasks.length) return null

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
