import { forwardRef, useCallback, useMemo, useState, type ComponentPropsWithoutRef } from "react"
import {
  ArrowLeftRight,
  Bell,
  BellOff,
  ChevronUp,
  DollarSign,
  FileText,
  Hash,
  LogOut,
  Moon,
  Plus,
  Settings,
} from "lucide-react"
import { useSearchParams } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { ACCOUNTS_LIST_KEY, accountsApi } from "@/api"
import { useAuth } from "@/auth"
import { LOGOUT_CONFIRM_PARAM } from "@/components/account-switcher/logout-scope-dialog"
import { useSettings, useSidebar } from "@/contexts"
import { useIsMobile } from "@/hooks/use-mobile"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { getInitials } from "@/lib/initials"
import { cn } from "@/lib/utils"
import { getAvatarUrl, resolveActiveStatus, resolveNotificationPause, type User } from "@threa/types"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { useStatusAutoExpiry } from "@/hooks/use-status-auto-expiry"
import { useNotificationPauseAutoExpiry } from "@/hooks/use-notification-pause-auto-expiry"
import { useResumeNotifications } from "@/hooks"
import { formatNotificationPauseLabel, formatStatusClearLabel } from "@/lib/status"
import { StatusPicker } from "@/components/status/status-picker"
import { PauseNotificationsDialog } from "@/components/notifications/pause-notifications-dialog"
import { WS_SETTINGS_PARAM } from "@/components/workspace-settings/tab-config"
import { SidebarActionDrawer, SidebarActionMenu, type SidebarActionItem } from "./sidebar-actions"

/** Resolved, expiry-masked status glyph + text for the footer's own user. */
interface FooterStatus {
  glyph: string | null
  text: string | null
  expiresAt: string | null
}

interface SidebarFooterProps {
  workspaceId: string
  currentUser: User | null
  /** Create a default scratchpad — the New button's primary click. */
  onCreateScratchpad: () => void | Promise<void>
  /** Open the create-channel flow — the New menu's "New Channel" entry. */
  onCreateChannel: () => void | Promise<void>
  /**
   * Scratchpad creators (Scratchpad / Quick Note / Encrypted) for the New menu;
   * merged with a "New Channel" entry so every stream flavor is reachable from
   * the always-visible footer button.
   */
  scratchpadAddMenuActions?: SidebarActionItem[]
}

/**
 * Avatar + optional corner status-emoji badge; absolutely positioned (no shift,
 * INV-21). `showBadge` is off on surfaces that already show the status emoji as
 * text alongside (the menu card), so the glyph never appears twice.
 */
function FooterAvatar({
  avatarSrc,
  currentUser,
  status,
  className,
  badgeClassName,
  showBadge = true,
}: {
  avatarSrc?: string | null
  currentUser: User
  status: FooterStatus | null
  className: string
  badgeClassName: string
  showBadge?: boolean
}) {
  return (
    <span className="relative inline-flex shrink-0">
      <Avatar className={className}>
        {avatarSrc && <AvatarImage src={avatarSrc} alt={currentUser.name} />}
        <AvatarFallback className="text-[10px]">{getInitials(currentUser.name)}</AvatarFallback>
      </Avatar>
      {showBadge && status?.glyph && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute -right-0.5 -bottom-0.5 flex items-center justify-center rounded-full bg-background leading-none",
            badgeClassName
          )}
        >
          {status.glyph}
        </span>
      )}
    </span>
  )
}

interface SidebarFooterTriggerProps extends Omit<ComponentPropsWithoutRef<"button">, "children"> {
  avatarSrc?: string | null
  currentUser: User
  status: FooterStatus | null
}

const SidebarFooterTrigger = forwardRef<HTMLButtonElement, SidebarFooterTriggerProps>(
  ({ avatarSrc, currentUser, status, className, type = "button", ...buttonProps }, ref) => {
    // The emoji rides the avatar badge; the subtitle shows only the text so the
    // glyph never appears twice. Emoji-only statuses surface via the badge alone.
    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          "w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          "hover:bg-muted/50",
          className
        )}
        {...buttonProps}
      >
        <FooterAvatar
          avatarSrc={avatarSrc}
          currentUser={currentUser}
          status={status}
          className="h-7 w-7"
          badgeClassName="text-[10px]"
        />
        <span className="flex-1 min-w-0 flex flex-col text-left">
          <span className="truncate">{currentUser.name}</span>
          {status?.text && <span className="truncate text-xs font-normal text-muted-foreground">{status.text}</span>}
        </span>
        <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
      </button>
    )
  }
)

SidebarFooterTrigger.displayName = "SidebarFooterTrigger"

/**
 * The identity card at the top of the account menu. Tapping it opens the status
 * picker — this is the single "set your status" affordance (there's no separate
 * status row). Shows the current status (emoji + text + when it clears) or a
 * "Set a status" hint.
 */
function SidebarStatusHeader({
  avatarSrc,
  currentUser,
  status,
  dndLabel,
  onClick,
}: {
  avatarSrc?: string | null
  currentUser: User
  status: FooterStatus | null
  dndLabel: string | null
  onClick: () => void
}) {
  const clears = status ? formatStatusClearLabel(status.expiresAt) : null
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={status ? "Update your status" : "Set a status"}
      className="block w-full p-1 text-left"
    >
      <div className="rounded-lg bg-muted/60 px-3 py-2.5 transition-colors hover:bg-muted">
        <div className="flex items-center gap-3">
          <FooterAvatar
            avatarSrc={avatarSrc}
            currentUser={currentUser}
            status={status}
            className="h-9 w-9"
            badgeClassName="text-xs"
            // The status emoji shows in the text line below, so don't badge the
            // avatar too — one indicator per surface.
            showBadge={false}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{currentUser.name}</p>
            {status?.text || status?.glyph ? (
              <p className="truncate text-xs text-muted-foreground">
                {status.glyph && <span className="mr-1">{status.glyph}</span>}
                {status.text}
              </p>
            ) : (
              <p className="truncate text-xs text-muted-foreground">Set a status</p>
            )}
            {clears && <p className="truncate text-[11px] text-muted-foreground/70">{clears}</p>}
            {dndLabel && (
              <p className="flex items-center gap-1 truncate text-[11px] text-muted-foreground/70">
                <Moon className="h-2.5 w-2.5 shrink-0" />
                {dndLabel}
              </p>
            )}
          </div>
        </div>
      </div>
    </button>
  )
}

export function SidebarFooter({
  workspaceId,
  currentUser,
  onCreateScratchpad,
  onCreateChannel,
  scratchpadAddMenuActions,
}: SidebarFooterProps) {
  const [, setSearchParams] = useSearchParams()
  const { openSettings } = useSettings()
  const { logout } = useAuth()
  const { collapseOnMobile } = useSidebar()
  const isMobile = useIsMobile()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [statusOpen, setStatusOpen] = useState(false)
  const [pauseOpen, setPauseOpen] = useState(false)
  const queryClient = useQueryClient()
  const resumeNotifications = useResumeNotifications(workspaceId)
  const { toEmoji } = useWorkspaceEmoji(workspaceId)

  const status = useMemo<FooterStatus | null>(() => {
    if (!currentUser) return null
    const active = resolveActiveStatus({
      statusEmoji: currentUser.statusEmoji ?? null,
      statusText: currentUser.statusText ?? null,
      statusExpiresAt: currentUser.statusExpiresAt ?? null,
    })
    if (!active) return null
    return { glyph: active.emoji ? toEmoji(active.emoji) : null, text: active.text, expiresAt: active.expiresAt }
  }, [currentUser, toEmoji])

  // The current pause (do-not-disturb), if any, drives the sidebar badge label
  // and the account-menu pause/resume entry. A manual (or status+manual) pause
  // can be resumed here; a status-only pause is managed through the status.
  const pause = useMemo(() => (currentUser ? resolveNotificationPause(currentUser) : null), [currentUser])
  const dndLabel = pause ? formatNotificationPauseLabel(pause) : null
  const manualPaused = pause !== null && pause.source !== "status"

  const openStatus = useCallback(() => {
    collapseOnMobile()
    setDrawerOpen(false)
    setMenuOpen(false)
    setStatusOpen(true)
  }, [collapseOnMobile])

  const openPause = useCallback(() => {
    collapseOnMobile()
    setDrawerOpen(false)
    setMenuOpen(false)
    setPauseOpen(true)
  }, [collapseOnMobile])

  const resumeNotificationsFromMenu = useCallback(() => {
    collapseOnMobile()
    resumeNotifications.mutate(undefined, {
      onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to resume notifications"),
    })
  }, [collapseOnMobile, resumeNotifications])

  // The owner's session clears its own status when it lapses, broadcasting the
  // clear to every viewer (render-time masking only hides it locally).
  useStatusAutoExpiry(workspaceId, currentUser)
  // Same for a manual timed notification pause, so the do-not-disturb badge
  // clears for every viewer when the window ends rather than lingering on an
  // idle page until its next render.
  useNotificationPauseAutoExpiry(workspaceId, currentUser)

  // Every stream flavor reachable from one always-visible control: the scratchpad
  // creators (Scratchpad / Quick Note / Encrypted) plus channels.
  const createActions = useMemo<SidebarActionItem[]>(() => {
    const scratchpadActions: SidebarActionItem[] = scratchpadAddMenuActions ?? [
      { id: "new-scratchpad", label: "New Scratchpad", icon: FileText, onSelect: onCreateScratchpad },
    ]
    return [
      ...scratchpadActions,
      { id: "new-channel", label: "New Channel", icon: Hash, onSelect: onCreateChannel, separatorBefore: true },
    ]
  }, [scratchpadAddMenuActions, onCreateScratchpad, onCreateChannel])

  // One Settings entry; it opens on the default (profile) tab. Profile no
  // longer has its own menu row — two entries into the same dialog read as
  // two different surfaces.
  const handleOpenSettings = useCallback(() => {
    collapseOnMobile()
    openSettings("profile")
  }, [collapseOnMobile, openSettings])

  const openWorkspaceSettings = useCallback(() => {
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

  const openAccountSwitcher = useCallback(() => {
    collapseOnMobile()
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set("account-switcher", "")
        return next
      },
      { replace: true }
    )
  }, [collapseOnMobile, setSearchParams])

  // Single-account: full logout is unambiguous. Multi-account: defer to the
  // confirm dialog so the user picks current-only vs all. The accounts query
  // is the same one the switcher uses, so a cached value usually answers
  // instantly; a cold call still costs one request before the menu reacts.
  // Network failure falls back to the all-accounts path — refusing to log out
  // because we couldn't count accounts is the worse failure mode.
  const handleLogout = useCallback(async () => {
    try {
      const data = await queryClient.fetchQuery({
        queryKey: ACCOUNTS_LIST_KEY,
        queryFn: () => accountsApi.list(),
        staleTime: 10_000,
      })
      const liveCount = data.accounts.filter((a) => a.state !== "stale").length
      if (liveCount > 1) {
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev)
            next.set(LOGOUT_CONFIRM_PARAM, "")
            return next
          },
          { replace: true }
        )
        return
      }
    } catch {
      // Fall through to all-accounts logout.
    }
    logout()
  }, [queryClient, setSearchParams, logout])

  const avatarSrc = currentUser ? getAvatarUrl(workspaceId, currentUser.avatarUrl, 64) : null
  const menuActions = useMemo<SidebarActionItem[]>(
    () => [
      // Manual do-not-disturb, one tap from the account menu (independent of
      // status). Flips to a one-tap resume while a manual pause is active.
      manualPaused
        ? {
            id: "resume-notifications",
            label: "Resume notifications",
            description: dndLabel,
            icon: Bell,
            onSelect: resumeNotificationsFromMenu,
            separatorBefore: true,
          }
        : {
            id: "pause-notifications",
            label: "Pause notifications",
            description: dndLabel,
            icon: BellOff,
            onSelect: openPause,
            separatorBefore: true,
          },
      {
        id: "settings",
        label: "Settings",
        icon: Settings,
        onSelect: handleOpenSettings,
      },
      {
        id: "workspace-settings",
        label: "Workspace Settings",
        icon: Settings,
        onSelect: openWorkspaceSettings,
      },
      {
        id: "ai-usage",
        label: "AI Usage",
        icon: DollarSign,
        href: `/w/${workspaceId}/admin/ai-usage`,
        onSelect: collapseOnMobile,
        separatorBefore: true,
      },
      {
        id: "switch-account",
        label: "Switch account",
        icon: ArrowLeftRight,
        onSelect: openAccountSwitcher,
        separatorBefore: true,
      },
      {
        id: "logout",
        label: "Log out",
        icon: LogOut,
        onSelect: handleLogout,
      },
    ],
    [
      manualPaused,
      dndLabel,
      openPause,
      resumeNotificationsFromMenu,
      handleOpenSettings,
      openWorkspaceSettings,
      openAccountSwitcher,
      collapseOnMobile,
      handleLogout,
      workspaceId,
    ]
  )

  if (!currentUser) return null

  if (isMobile) {
    return (
      <div className="flex flex-col gap-1.5">
        <SidebarCreateButton actions={createActions} isMobile />
        <SidebarFooterTrigger
          avatarSrc={avatarSrc}
          currentUser={currentUser}
          status={status}
          onClick={() => setDrawerOpen(true)}
        />
        <SidebarActionDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          actions={menuActions}
          title="Account menu"
          description="Choose an account action."
          header={
            <SidebarStatusHeader
              avatarSrc={avatarSrc}
              currentUser={currentUser}
              status={status}
              dndLabel={dndLabel}
              onClick={openStatus}
            />
          }
        />
        {statusOpen && <StatusPicker workspaceId={workspaceId} open onOpenChange={setStatusOpen} />}
        {pauseOpen && <PauseNotificationsDialog workspaceId={workspaceId} open onOpenChange={setPauseOpen} />}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <SidebarCreateButton actions={createActions} isMobile={false} />
      <SidebarActionMenu
        actions={menuActions}
        ariaLabel="Account menu"
        side="top"
        align="start"
        contentClassName="w-64"
        open={menuOpen}
        onOpenChange={setMenuOpen}
        header={
          <SidebarStatusHeader
            avatarSrc={avatarSrc}
            currentUser={currentUser}
            status={status}
            dndLabel={dndLabel}
            onClick={openStatus}
          />
        }
        trigger={<SidebarFooterTrigger avatarSrc={avatarSrc} currentUser={currentUser} status={status} />}
      />
      {statusOpen && <StatusPicker workspaceId={workspaceId} open onOpenChange={setStatusOpen} />}
    </div>
  )
}

// Shared face for the create control. A gold "thread" chip carries the emphasis
// (per the design system, --primary is the single accent that signals primary
// actions), the label sits left-aligned so the control reads as a sidebar row
// rather than a form button, and the trailing chevron telegraphs the upward
// menu — rhyming with the account row beneath it. The whole face reacts to the
// trigger's `data-state` so hover and open share one warm treatment; both the
// Radix desktop trigger and the manual mobile button expose that attribute.
function SidebarCreateButtonFace() {
  return (
    <>
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary transition-colors group-hover/new:bg-primary/25 group-data-[state=open]/new:bg-primary/25">
        <Plus className="h-4 w-4" />
      </span>
      <span className="flex-1 text-left font-medium">New</span>
      <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]/new:rotate-180" />
    </>
  )
}

const CREATE_BUTTON_CLASS =
  "group/new w-full justify-start gap-2.5 px-3 bg-primary/[0.04] hover:bg-primary/10 hover:text-foreground data-[state=open]:bg-primary/10 data-[state=open]:text-foreground"

/**
 * The always-visible "New" control at the bottom of the sidebar. Opens a menu of
 * every stream flavor (scratchpad variants + channel). Uses a bottom drawer on
 * mobile and a dropdown on desktop, mirroring the account menu beneath it.
 * Top-level per INV-18.
 */
function SidebarCreateButton({ actions, isMobile }: { actions: SidebarActionItem[]; isMobile: boolean }) {
  const [open, setOpen] = useState(false)

  if (isMobile) {
    return (
      <>
        <Button
          variant="ghost"
          size="sm"
          className={CREATE_BUTTON_CLASS}
          data-state={open ? "open" : "closed"}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <SidebarCreateButtonFace />
        </Button>
        <SidebarActionDrawer
          open={open}
          onOpenChange={setOpen}
          actions={actions}
          title="Create"
          description="Start a new stream."
        />
      </>
    )
  }

  return (
    <SidebarActionMenu
      actions={actions}
      ariaLabel="Create stream"
      side="top"
      align="start"
      contentClassName="w-56"
      trigger={
        <Button variant="ghost" size="sm" className={CREATE_BUTTON_CLASS}>
          <SidebarCreateButtonFace />
        </Button>
      }
    />
  )
}
