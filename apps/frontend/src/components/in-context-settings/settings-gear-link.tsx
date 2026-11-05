import type { MouseEvent } from "react"
import { Link } from "react-router-dom"
import { Settings2 } from "lucide-react"
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { useSettingHref } from "@/hooks/use-setting-href"
import type { SettingId } from "@/components/settings/settings-registry"
import { cn } from "@/lib/utils"

/**
 * 24px with a 44px touch target. The side margins on coarse pointers keep the
 * enlarged target off its neighbours, so a tap never lands on the wrong control.
 */
const SETTINGS_GEAR_CLASSES =
  "relative inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none [@media(pointer:coarse)]:mx-2.5 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2.5"

function stopPropagation(event: MouseEvent) {
  event.stopPropagation()
}

/**
 * The gear beside a behavior that a setting controls (a link preview, a code
 * block, a folded message), landing on that setting. Absent outside the
 * workspace shell.
 */
export function SettingsGearLink({
  setting,
  label,
  className,
}: {
  setting: SettingId
  label: string
  className?: string
}) {
  const href = useSettingHref(setting)
  if (!href) return null
  return (
    <Link
      to={href}
      onClick={stopPropagation}
      aria-label={label}
      title={label}
      className={cn(SETTINGS_GEAR_CLASSES, className)}
    >
      <Settings2 className="size-3.5" aria-hidden />
    </Link>
  )
}

/**
 * A menu row landing on a setting; absent outside the workspace shell. Render it
 * inside open menu content only, so the menu's owner never subscribes to the settings url.
 */
export function SettingsMenuItem({
  setting,
  label,
  separatorBefore = false,
}: {
  setting: SettingId
  label: string
  separatorBefore?: boolean
}) {
  const href = useSettingHref(setting)
  if (!href) return null
  return (
    <>
      {separatorBefore && <DropdownMenuSeparator />}
      <DropdownMenuItem asChild>
        <Link to={href}>
          <Settings2 className="mr-2 h-4 w-4" />
          {label}
        </Link>
      </DropdownMenuItem>
    </>
  )
}
