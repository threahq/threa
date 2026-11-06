import { useState } from "react"
import { ChevronUp, LogOut } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer"
import { cn } from "@/lib/utils"

/**
 * Account menu surfaces the signed-in user and the sign-out action behind a
 * deliberate two-step interaction. A bare LogOut icon was too easy to hit by
 * accident — the menu adds the friction without adding ceremony.
 *
 * Two flavours, both rendered conditionally by `BackofficeShell`:
 *
 * - `SidebarUserMenu` lives at the bottom of the desktop sidebar. Click the
 *   avatar+name pill → DropdownMenu opens above it.
 * - `MobileUserMenu` lives at the right of the mobile slim header. Tap the
 *   avatar circle → bottom-sheet Drawer slides up.
 */

interface UserMenuProps {
  email: string | undefined
  name: string | undefined
  onSignOut: () => void
}

function deriveDisplay({ email, name }: { email: string | undefined; name: string | undefined }) {
  const display = name || email || "Signed in"
  const initial = (name?.[0] || email?.[0] || "?").toUpperCase()
  const showEmailLine = !!email && email !== display
  return { display, initial, showEmailLine }
}

// ── Desktop sidebar variant ────────────────────────────────────────────

export function SidebarUserMenu({ email, name, onSignOut }: UserMenuProps) {
  const { display, initial, showEmailLine } = deriveDisplay({ email, name })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
            "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[state=open]:bg-muted"
          )}
        >
          <UserAvatar initial={initial} size="sm" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium text-foreground">{display}</span>
            <span className="truncate text-xs text-muted-foreground">{showEmailLine ? email : "Platform admin"}</span>
          </div>
          <ChevronUp className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent side="top" align="start" className="w-[--radix-dropdown-menu-trigger-width]">
        <UserMenuHeader display={display} email={email} initial={initial} />
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onSignOut}
          className="text-destructive focus:bg-destructive/10 focus:text-destructive"
        >
          <LogOut className="size-4" />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ── Mobile header variant ──────────────────────────────────────────────

export function MobileUserMenu({ email, name, onSignOut }: UserMenuProps) {
  const [open, setOpen] = useState(false)
  const { display, initial } = deriveDisplay({ email, name })

  const handleSignOut = () => {
    setOpen(false)
    onSignOut()
  }

  return (
    <>
      <button
        type="button"
        aria-label="Open account menu"
        onClick={() => setOpen(true)}
        className="flex size-11 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <UserAvatar initial={initial} size="md" />
      </button>

      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent className="max-h-[60dvh]">
          <DrawerTitle className="sr-only">Account menu</DrawerTitle>
          <DrawerDescription className="sr-only">Choose an account action.</DrawerDescription>

          <div className="px-4 pt-2 pb-3">
            <UserMenuHeader display={display} email={email} initial={initial} variant="drawer" />
          </div>

          <div className="px-2 pb-[max(16px,env(safe-area-inset-bottom))]">
            <button
              type="button"
              onClick={handleSignOut}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm text-destructive transition-colors active:bg-destructive/10"
            >
              <LogOut className="size-[18px] shrink-0" />
              <span>Sign out</span>
            </button>
          </div>
        </DrawerContent>
      </Drawer>
    </>
  )
}

// ── Shared bits ────────────────────────────────────────────────────────

function UserAvatar({ initial, size }: { initial: string; size: "sm" | "md" }) {
  const sizeClass = size === "sm" ? "size-8 text-sm" : "size-9 text-sm"
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-avatar bg-accent font-semibold text-accent-foreground",
        sizeClass
      )}
    >
      {initial}
    </span>
  )
}

function UserMenuHeader({
  display,
  email,
  initial,
  variant = "menu",
}: {
  display: string
  email: string | undefined
  initial: string
  variant?: "menu" | "drawer"
}) {
  // The drawer header gets a softer card background since it stands alone in
  // a sheet rather than at the top of a tight popover.
  const wrapperClass =
    variant === "drawer"
      ? "flex items-center gap-3 rounded-xl bg-muted/60 px-3.5 py-3"
      : "flex items-center gap-2.5 px-2 py-1.5"

  return (
    <div className={wrapperClass}>
      <UserAvatar initial={initial} size={variant === "drawer" ? "md" : "sm"} />
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-sm font-medium text-foreground">{display}</span>
        <span className="truncate text-xs text-muted-foreground">
          {email && email !== display ? email : "Platform admin"}
        </span>
      </div>
    </div>
  )
}
