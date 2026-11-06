import { memo } from "react"
import { Link } from "react-router-dom"
import { Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { SettingsGearLink } from "@/components/in-context-settings/settings-gear-link"
import { useComposerActionSide } from "@/hooks/use-composer-action-side"
import { useSettingHref } from "@/hooks/use-setting-href"
import { SETTING_NOTE_TEXT } from "@/components/settings/setting-text"
import { cn } from "@/lib/utils"

const LABEL = "Composer settings"
const SEND_HINT_ACTION = "Change send key"

/** A Send moved to the left is the composer's most visible setting, so that is where its gear lands. */
function useComposerSetting() {
  return useComposerActionSide() === "left" ? "send-side" : "send-key"
}

/** Trailing icon on the desktop formatting row. Mounted only while the row is open. */
export function ComposerSettingsButton() {
  return (
    <SettingsGearLink
      setting={useComposerSetting()}
      label={LABEL}
      className="ml-auto size-7 [@media(pointer:coarse)]:ml-auto"
    />
  )
}

/** A row in the phone composer's + menu. Mounted only while the menu is open. */
export function ComposerSettingsMenuRow({ onNavigate }: { onNavigate: () => void }) {
  const href = useSettingHref(useComposerSetting())
  if (!href) return null
  return (
    <Button asChild variant="ghost" size="sm" className="h-11 w-full justify-start gap-2 px-2 text-sm sm:h-9">
      <Link to={href} onPointerDown={(e) => e.preventDefault()} onClick={onNavigate}>
        <Settings2 className="h-4 w-4" aria-hidden />
        {LABEL}
      </Link>
    </Button>
  )
}

const HINT_CLASS = cn("text-muted-foreground select-none", SETTING_NOTE_TEXT)
// A 44px-tall hit area on touch, drawn outside the text so the composer row keeps its height.
const COARSE_TARGET =
  "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:inset-x-0 [@media(pointer:coarse)]:after:top-1/2 [@media(pointer:coarse)]:after:h-11 [@media(pointer:coarse)]:after:-translate-y-1/2"

/**
 * The desktop composer's send hint, linked to the send key setting it describes.
 * Plain text outside the workspace shell. Memoized: the composer re-renders on
 * every keystroke, and the tooltip around the link is a dozen components.
 */
export const ComposerSendHint = memo(function ComposerSendHint({ hint }: { hint: string }) {
  const href = useSettingHref("send-key")
  if (!href) return <span className={cn(HINT_CLASS, "pointer-events-none")}>{hint}</span>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={href}
          className={cn(
            HINT_CLASS,
            COARSE_TARGET,
            "rounded-sm underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          )}
        >
          {hint}
          <span className="sr-only">, {SEND_HINT_ACTION.toLowerCase()}</span>
        </Link>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {SEND_HINT_ACTION}
      </TooltipContent>
    </Tooltip>
  )
})
